# BimmerStein Bin Analyzer

An open-source desktop app for **ECU bin file tuning-table analysis**: load a raw ECU firmware dump, view it as hexdump / 2D / 3D, automatically detect tuning tables ("maps") and their axes, refine them manually, and export RomRaider XML / TunerPro XDF / CSV / JSON definitions.

**Status: v0.1.0 — first public preview, under active development.** v1 is
analysis-only (read-only): it never modifies bin bytes. Editing and checksum
tooling come later.

Currently targets Windows. macOS/Linux builds are untested (Tauri supports
them, but nothing here has been verified on those platforms yet).

## Try it (Windows)

No published installer yet — build one from source:

1. Install the prerequisites below (Node.js, pnpm, Rust + Tauri prerequisites).
2. Clone this repo, then double-click **`build-installer.cmd`** at the repo
   root. First run compiles a Rust release build (10+ minutes). Installers
   land under `apps/desktop/src-tauri/target/release/bundle/` (`msi/` and
   `nsis/`); a standalone `desktop.exe` needing no install lands one level
   up, at `apps/desktop/src-tauri/target/release/desktop.exe`.
3. To hack on the app instead (hot-reload, no installer), double-click
   **`run-app.cmd`** — this runs `pnpm dev` for you.

Both `.cmd` files just wrap `pnpm install` plus one pnpm command (`pnpm dev`
for the dev launcher, `pnpm --filter desktop tauri build` for the installer
build), so you can run those from a terminal instead if you prefer seeing
the output scroll by.

**Unsigned installer / "Windows protected your PC":** this is not a
notarized release — there's no code-signing certificate yet — so Windows
SmartScreen will flag the installer or `desktop.exe` on first run. Click
**More info → Run anyway** to proceed. If you'd rather not trust an unsigned
binary, build it yourself from source with the steps above so you know
exactly what ran.

## Architecture

Tauri 2 desktop shell, all logic in TypeScript (pnpm monorepo):

| Package | Purpose |
|---|---|
| `packages/core` | Types, value codecs, scaling, project model. Depends on nothing. |
| `packages/engine` | Map-detection pipeline. Pure (no fs/DOM); runs in a Web Worker. |
| `packages/formats` | RomRaider XML, TunerPro XDF, CSV/JSON, project file. Pure. |
| `packages/eval` | Detection-quality harness (Node CLI) with ground-truth fixtures. |
| `apps/desktop` | Tauri 2 + Vite + Svelte 5 UI. All file I/O lives here. |

## Prerequisites

To build from source (either launcher, or the commands below):

- Node.js ≥ 22 LTS, pnpm ≥ 9 (`corepack enable`)
- Rust stable + [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/),
  including the MSVC "Desktop development with C++" workload
- WebView2 Runtime — ships with Windows 11 already; Windows 10 users may need
  to install it from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)
  first

## Development

```sh
pnpm install
pnpm test        # all package tests (Vitest)
pnpm typecheck
pnpm eval        # detection-quality report against fixtures
pnpm dev         # desktop app (Tauri window; first run compiles Rust — minutes)
```

## Fixtures & firmware

Real ECU firmware dumps are copyrighted and **never committed** — see [fixtures/README.md](fixtures/README.md). CI uses committed synthetic bins with planted maps.

## Continuous integration

Every push/PR runs `pnpm install`, `pnpm typecheck`, `pnpm test`, and the
detection-quality gate (`pnpm eval` + `pnpm eval holdout`) against the
committed synthetic fixtures — see
[.github/workflows/ci.yml](.github/workflows/ci.yml). The real-MS41
acceptance gate only runs locally, on a machine with the (gitignored) real
firmware fixtures in `fixtures/ms41/` — CI never has them, and both eval
commands are designed to pass cleanly without them.

## Legal

Independent, original work.

Copyright © 2026 BimmerStein Bin Analyzer contributors. License: [GPL-3.0-or-later](LICENSE).
