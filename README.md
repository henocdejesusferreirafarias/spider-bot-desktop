# SpiderBOT Desktop

Electron desktop client for SpiderBOT (multi-login browser profile manager). Extracted from the monorepo as part of repo separation (issue #1, Wave 6).

## Stack

- Electron + React 19 (Vite renderer)
- `native/license-core` — Rust/napi module (offline license validation)
- Python Geetest solver (`GeekedTest-main`, optional at runtime)
- Shared contracts: `@spider-bot/licensing-contracts` (pinned by Git tag)

## Develop

```powershell
npm install        # patch-package + napi build (needs Rust/cargo) + Python setup
npm run dev
```

## Verify

```powershell
npm run check      # typecheck (electron + renderer)
npm test           # unit tests
```

## Build / release (Windows)

```powershell
npm run dist:win     # local unsigned-config build
npm run publish:win  # build + publish to spider-bot-releases
```

The release workflow (`.github/workflows/desktop-release.yml`) runs on `desktop-v*` tags and **requires** these repo secrets/variables:

- Secrets: `RELEASES_REPO_TOKEN`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `PAYLOAD_SIGNING_PUBLIC_KEY`
- Variables: `WINDOWS_PUBLISHER_NAME`, `PAYLOAD_SIGNING_KID`

## Prerequisites

- Node 22+, Rust toolchain (for `license-core`), Python 3 (optional, for the Geetest solver)
