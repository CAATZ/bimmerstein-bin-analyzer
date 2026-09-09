# BimmerStein Bin Analyzer

[![CI](https://github.com/CAATZ/bimmerstein-bin-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/CAATZ/bimmerstein-bin-analyzer/actions/workflows/ci.yml)

An open-source desktop app for **ECU bin file tuning-table analysis and editing**: load a raw ECU firmware dump, view it as hexdump / 2D / 3D, automatically detect tuning tables ("maps") and their axes, refine and edit them, and export RomRaider XML / TunerPro XDF / CSV / JSON definitions.

**Status: v0.2.17 released.**

The latest published installers are v0.2.17. This release adds stricter
RomRaider numeric-axis parsing: labels containing text and non-finite numbers
retain an explicit warning and index fallback instead of becoming misleading
breakpoints. Complete decimal and scientific-notation values remain supported.
The application, setup and uninstaller now use the blue BimmerStein logo.

The app includes **value and axis editing**, undo/redo, original-value
display, checksum verification and supported correction, map packs, family
modules, and project lineage. Save Bin writes a separate output, protects the
loaded source path, and verifies the file by reading it back. Checksum reports
distinguish corrected, verified, and unchecked regions; MS41 program checksums
are reported but never rewritten. The older v0.1.1 download remains analysis-only.

Version 0.2.10 corrects MS41 curve and grid axis selection using firmware callers.
Curves retain their staged axis across helpers that preserve interpolation state,
and headerless grids use matching caller evidence to resolve competing axis pairs.
The MAF word-width fix and both voltage views remain available.
Version 0.2.11 accepts scalar `Value` labels in RomRaider definitions
without spurious axis warnings. It preserves imported values and metadata,
and keeps warnings for malformed axes and unsupported labels.
Version 0.2.12 exports fresh MS41 full-read detections with calibration-relative
addresses for RomRaider, including referenced axes, so definitions can be imported
into the matching partial image. Explicit address-frame choices remain respected.
Version 0.2.13 improves generic table row alignment and preserves exact starts
for gradual word tables. It also rejects more small filler blocks while retaining
validated MS41 table layouts and axes.
Version 0.2.14 adds axis-pair review in Map properties, with breakpoint previews
and one-step undo. It also improves generic table boundary detection using
row trends, while preserving validated MS41 detection results.
Version 0.2.15 adds **Review table layout**, which previews alternative addresses,
dimensions and byte formats in Map properties. Applying a layout updates the
definition in one undo step while preserving BIN bytes and existing edits.
Version 0.2.16 corrects table byte widths when neighboring grid headers provide
stronger boundary evidence. MS41 full reads also distinguish axis descriptors
from curve data, preventing curves from being detected two bytes early.
The **Swap X/Y** display control and column-major axis editing remain available. Search
maps by name, address or dimensions, filter by shape or detection method, and
inspect an explanation of how each potential map was detected. Swapping the
display preserves stored bytes and exported definitions.

Currently targets Windows. macOS/Linux builds are untested (Tauri supports
them, but nothing here has been verified on those platforms yet).

## Try it (Windows)

Download an installer from [Releases](https://github.com/CAATZ/bimmerstein-bin-analyzer/releases):
`.msi` (Windows Installer) or `-setup.exe` (NSIS). Both are unsigned — see the
SmartScreen note below.

Or build from source:

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
| `packages/families` | Per-ECU-family byte semantics: image identity and checksum verify/correct. Pure. |
| `packages/appkit` | Adapter helpers shared by the two apps (definition address framing). Pure. |
| `packages/eval` | Detection-quality harness (Node CLI) with ground-truth fixtures. |
| `apps/desktop` | Tauri 2 + Vite + Svelte 5 UI. |
| `apps/mcp` | Stdio server exposing the engine — and, when attached to a running app, that live session — to external tooling. See [apps/mcp/README.md](apps/mcp/README.md). |

File I/O lives only in `apps/*` and `packages/eval`; the five `packages/*`
libraries above them are pure and import nothing from an app.

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

Every push/PR runs `pnpm install`, `pnpm typecheck`, `pnpm test`, and three
detection-quality gates — `pnpm eval`, `pnpm eval holdout` (anti-overfitting)
and `pnpm eval accept` — see
[.github/workflows/ci.yml](.github/workflows/ci.yml). The first two score the
committed synthetic fixtures. `pnpm eval accept` is the real-firmware
acceptance gate: it runs in CI as well, but the real MS41 bins are gitignored
and never present there, so it skips those rows cleanly and only does real work
on a machine that has them in `fixtures/ms41/`.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
covers the setup, the package boundaries, and the invariants that keep
detection quality honest — most importantly that the quality gates are
ratchets and are never relaxed to make a change fit.

Security issues: please follow [SECURITY.md](SECURITY.md) rather than opening a
public issue.

## Legal

Independent, original work. Not affiliated with, endorsed by, or sponsored by
any vehicle or ECU manufacturer.

Third-party components bundled in the installers are attributed in [NOTICE](NOTICE).

Copyright © 2026 BimmerStein Bin Analyzer contributors. License: [GPL-3.0-or-later](LICENSE).
