param (
  [ValidateSet("never", "always")]
  [string]$Publish = "never"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# resolve GH_TOKEN: env var first, then .gh-token file
if (-not $env:GH_TOKEN) {
  $tokenFile = Join-Path $PWD ".gh-token"
  if (Test-Path $tokenFile) {
    $env:GH_TOKEN = (Get-Content $tokenFile -Raw).Trim()
  }
}

function Invoke-Step {
  param (
    [string]$Command,
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$hasSigningIdentity = $env:CSC_LINK -or $env:WIN_CSC_LINK -or $env:CSC_NAME -or $env:WIN_CSC_NAME
if ($Publish -eq "always" -and (-not $env:PAYLOAD_SIGNING_PUBLIC_KEY -or -not $env:PAYLOAD_SIGNING_KID)) {
  throw "Publicacao bloqueada: configure PAYLOAD_SIGNING_PUBLIC_KEY e PAYLOAD_SIGNING_KID no build."
}
if (-not $hasSigningIdentity) {
  if ($Publish -eq "always") {
    throw "Publicacao bloqueada: configure CSC_LINK/CSC_KEY_PASSWORD e WINDOWS_PUBLISHER_NAME."
  }
  if ($env:ALLOW_UNSIGNED_DESKTOP_BUILD -ne "true") {
    throw "Build sem assinatura bloqueado. Para um build local nao publicavel, defina ALLOW_UNSIGNED_DESKTOP_BUILD=true."
  }
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
  $env:SPIDER_BOT_PATCH_WIN_ICON = "true"
  $builderArguments = @(
    "electron-builder",
    "--win",
    "nsis",
    "--publish",
    $Publish,
    "-c.win.forceCodeSigning=false",
    "-c.win.signAndEditExecutable=false"
  )
} else {
  if (-not $env:WINDOWS_PUBLISHER_NAME) {
    throw "WINDOWS_PUBLISHER_NAME e obrigatorio para validar a assinatura."
  }
  $env:SPIDER_BOT_PATCH_WIN_ICON = "false"
  $builderArguments = @("electron-builder", "--win", "nsis", "--publish", $Publish)
}

# Frente C: compila o nucleo nativo de licenca (gera o .node) antes do empacotamento.
# Requer a toolchain Rust + MSVC Build Tools na maquina de release.
Invoke-Step "npm.cmd" @("run", "napi:build", "-w", "@spider-bot/license-core")
Invoke-Step "npm.cmd" @("run", "build")

# Redireciona output para diretorio temporario fora do OneDrive para evitar
# travamento de arquivos (app.asar) pelo Windows Search / OneDrive sync.
$tempRelease = Join-Path $env:TEMP "spider-bot-release"
if (Test-Path $tempRelease) {
  Remove-Item -Path $tempRelease -Recurse -Force -ErrorAction SilentlyContinue
}
$builderArguments += "-c.directories.output=$tempRelease"

Invoke-Step "npx.cmd" $builderArguments

if ($hasSigningIdentity) {
  $signedFiles = @(
    Get-ChildItem -Path $tempRelease -Recurse -File |
      Where-Object { $_.Extension -in @(".exe", ".node") }
  )
  if ($signedFiles.Count -eq 0) {
    throw "Nenhum executavel assinado foi encontrado para validacao."
  }
  foreach ($file in $signedFiles) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne "Valid") {
      throw "Assinatura invalida em $($file.FullName): $($signature.Status)"
    }
    if (-not $signature.SignerCertificate.Subject.Contains($env:WINDOWS_PUBLISHER_NAME)) {
      throw "Publisher inesperado em $($file.FullName): $($signature.SignerCertificate.Subject)"
    }
  }
}

# Copia os artifacts de volta para o diretorio do projeto
$projectRelease = Join-Path $PWD "release"
if (Test-Path $projectRelease) {
  Remove-Item -Path $projectRelease -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -Path $projectRelease -ItemType Directory -Force | Out-Null
Copy-Item -Path (Join-Path $tempRelease "*") -Destination $projectRelease -Recurse -Force

Get-ChildItem -Path $projectRelease -File |
  Where-Object { $_.Extension -in @(".exe", ".yml", ".blockmap") } |
  ForEach-Object {
    $stream = [System.IO.File]::OpenRead($_.FullName)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
      "$hash  $($_.Name)"
    } finally {
      $sha256.Dispose()
      $stream.Dispose()
    }
  } |
  Set-Content -LiteralPath (Join-Path $projectRelease "SHA256SUMS.txt") -Encoding ascii
