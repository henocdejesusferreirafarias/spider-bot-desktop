# @spider-bot/license-core

Núcleo nativo de licenciamento em Rust (N-API). Move para código compilado, fora
do `app.asar` patchável, as operações sensíveis:

- `verifyLicenseToken(token)` → string JSON dos claims. Verifica Ed25519 usando
  a chave pública e o `kid` compilados no binário; o JavaScript não escolhe a
  âncora de confiança.
- `computeFingerprint()` → `string | null` (fingerprint atado a hardware da
  máquina).
- `getDeviceIdentity(storagePath)` e `signDeviceProof(...)` → identidade
  Ed25519/X25519 aleatória, com seeds privadas protegidas pelo DPAPI.
- `decapsulateSignedPayload(...)` → abre o envelope X25519/HKDF/AES-GCM e só
  devolve o conteúdo depois de validar hash, assinatura e `kid` do artefato.

## Pré-requisitos (toolchain — instalar uma vez)

1. **Rust** (rustup): https://rustup.rs — no Windows instala o target
   `x86_64-pc-windows-msvc`.
2. **Visual Studio Build Tools** com o workload "Desktop development with C++"
   (linker MSVC). Já costuma estar presente em máquinas com Node-gyp.

Verifique: `cargo --version` e `rustc --version`.

## Build

A partir da raiz do monorepo (o `@napi-rs/cli` vem como devDependency deste
pacote):

```bash
npm install            # resolve o workspace e o @napi-rs/cli
npm run build:native   # = napi build --platform --release (neste pacote)
```

Saída (gerada, não commitada): `index.js`, `index.d.ts` e
`license-core.win32-x64-msvc.node` nesta pasta. O `@spider-bot/desktop` depende
deste pacote e o resolve por `require("@spider-bot/license-core")`.

## Empacotamento (electron-builder)

- O `.node` é desempacotado do asar via `asarUnpack: ["**/*.node"]` (já
  configurado no `package.json` do desktop). Node-API é ABI-estável, então **não**
  é necessário `electron-rebuild`.
- Rodar `npm run build:native` **antes** de `npm run dist:desktop`.

## Política de produção

O desktop empacotado exige o módulo nativo e falha fechado se ele estiver
ausente ou adulterado. Fallbacks JavaScript existem apenas em desenvolvimento.
O build também injeta `PAYLOAD_SIGNING_PUBLIC_KEY` e `PAYLOAD_SIGNING_KID`; a
chave privada de assinatura permanece fora do repositório e fora do servidor.

## Garantia de paridade (crítico)

`computeFingerprint` deve produzir **exatamente** o mesmo `v2$…` que o JS da
Frente A, senão trocar de implementação invalidaria devices já vinculados.
Mesmos salts (`spider-bot-hw-v2`, `spider-bot-device-v2`), mesma ordem
(`mg:` minúsculo, depois `csp:` maiúsculo), mesmo separador `|`, mesmo SHA-256
hex. Há um teste de paridade a adicionar comparando JS × nativo na mesma máquina.
