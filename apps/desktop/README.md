# apps/desktop

The Windows desktop app uses Tauri 2, Vite and Svelte 5, with one window and
one open BIN per session. Analysis, editing and save logic live in TypeScript.

See the root README for [installation](../../README.md#install-and-start) and
[source builds](../../README.md#build-from-source), or the
[user manual](../../manual/USER_MANUAL.md) for workspace controls and workflows.
This file covers the app's internal structure for contributors.

## Commands (repo root)

- `pnpm dev` — launch the app (`tauri dev`; needs Rust + VS Build Tools, see root README)
- `pnpm --filter desktop test` — Vitest unit tests (store/lib/worker/flows)
- `pnpm --filter desktop typecheck` — svelte-check

## Structure

| Dir | Owns |
|---|---|
| `src/store/` | Session state, edit actions, undo/redo and save snapshots |
| `src/lib/` | View data, keyboard dispatch, layout review, save reports and module loading |
| `src/worker/` | Detection and layout-review workers, protocols and cancellation |
| `src/platform/` | Host APIs and file, family-module and save flows |
| `src/views/` | Hexdump, 2D, tables, curves, switches and 3D surfaces/preview |
| `src/components/` | toolbar, sidebar, status bar, toasts, dialogs (thin) |
| `src/copilot/` | Optional AI co-pilot connection, session sharing and reviewed proposals |
| `src-tauri/` | Rust shell, application configuration, plugin registration and icons |

Use the core codecs for byte decoding and the existing edit journal and save
flows for byte changes. Full detection and layout review run in workers;
selection snapping uses a bounded local scan. The keyboard dispatcher owns
global shortcuts, including `+`/`-` for value steps and `F11` for original values.
