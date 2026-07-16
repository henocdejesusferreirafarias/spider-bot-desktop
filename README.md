# SpiderBOT Desktop

Electron desktop client for SpiderBOT (multi-login browser profile manager). Extracted from the monorepo as part of repo separation (issue #1, Wave 6).

## Stack

- Electron + React 19 (Vite renderer)
- `native/license-core` — Rust/napi module (offline license validation)
- TypeScript GeeTest `nine` solver with singleton ONNX inference
- Shared contracts: `@spider-bot/licensing-contracts` (pinned by Git tag)

## Develop

```powershell
npm install        # patch-package + napi build (needs Rust/cargo)
npm run dev
```

## Verify

```powershell
npm run check      # typecheck (electron + renderer)
npm test           # unit tests
```

## Speed Time

O controle Speed Time suporta atualmente os provedores **PG, WG, JDB e PP**.
Cada provedor usa um perfil de timing próprio, selecionado por sinais estáveis do
documento do jogo em vez de depender dos domínios dinâmicos de entrega.

Novos provedores serão adicionados conforme a necessidade. O registry e as
estratégias ficam em `src/main/services/provider-timing.ts`; quando um engine já
suportado puder ser reutilizado, a inclusão se limita ao perfil de dados. Engines
com relógios diferentes exigem uma estratégia específica e validação manual.

## Build / release (Windows)

```powershell
npm run dist:win     # local unsigned-config build
npm run publish:win  # build + publish to spider-bot-releases
```

The release workflow (`.github/workflows/desktop-release.yml`) runs on `desktop-v*` tags and **requires** these repo secrets/variables:

- Secrets: `RELEASES_REPO_TOKEN`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `PAYLOAD_SIGNING_PUBLIC_KEY`
- Variables: `WINDOWS_PUBLISHER_NAME`, `PAYLOAD_SIGNING_KID`

## Prerequisites

- Node 22+ and Rust toolchain (for `license-core`)
- Python 3 with training dependencies (optional, only for offline captcha model training)
