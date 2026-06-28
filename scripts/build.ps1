$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

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

Invoke-Step "npm.cmd" @("run", "typecheck")
Invoke-Step "npm.cmd" @("run", "build:renderer")
# Limpa o dist-electron antes de recompilar: o tsc NAO remove saidas orfas, entao
# arquivos movidos/removidos do src (ex.: o popup-killer movido para payloads/ no
# cutover da Frente B) vazariam para o pacote empacotado. Build limpo evita isso.
if (Test-Path "dist-electron") { Remove-Item -Recurse -Force "dist-electron" }
Invoke-Step "npm.cmd" @("run", "build:main")
