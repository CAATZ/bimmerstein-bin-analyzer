# apps/desktop

Tauri 2 + plain Vite + Svelte 5 desktop app (scaffolded by create-tauri-app
4.6.2 in plan task 5.1; the template's SvelteKit frontend was converted to
plain Vite per spec §7 — single window, no routing).

Just want to run or build the app? See the root [README](../../README.md#try-it-windows)
for the `.cmd` launchers, prerequisites, and the unsigned-installer
SmartScreen note. This file covers the app's internal structure for
contributors.

## Commands (repo root)

- `pnpm dev` — launch the app (`tauri dev`; needs Rust + VS Build Tools, see root README)
- `pnpm --filter desktop test` — Vitest unit tests (store/lib/worker/flows)
- `pnpm --filter desktop typecheck` — svelte-check

## Structure (spec §7)

| Dir | Owns |
|---|---|
| `src/store/` | typed app state + ALL mutations (unit-tested) |
| `src/lib/` | pure UI math: keymap, hexlayout, griddata, snap, romlist (unit-tested) |
| `src/worker/` | engine Web Worker: protocol, terminate-based cancel client |
| `src/platform/` | ALL Tauri API usage + fake-testable file flows |
| `src/views/` | Hexdump/2D/3D/Map canvases + preview overlay (manual-verified) |
| `src/components/` | toolbar, sidebar, status bar, toasts, dialogs (thin) |
| `src-tauri/` | generated Rust shell — config + plugin registration ONLY |

Rules: no app logic in Rust; keymap frozen in spec §7 (`+`/`-`/`F11` reserved);
all byte decoding via `@binanalyzer/core`; the engine runs ONLY in the worker.
