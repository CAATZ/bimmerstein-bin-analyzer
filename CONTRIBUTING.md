# Contributing

Thanks for taking an interest. This project analyses ECU firmware, where a
wrong answer looks exactly like a right one until someone flashes a car — so
the rules below are stricter than they might first appear. They are not
bureaucracy; each one exists because the alternative silently degrades
detection quality.

## Getting set up

```sh
corepack enable          # Node >= 22; use package.json's pinned pnpm version
pnpm install
pnpm test                # all package tests (Vitest)
pnpm typecheck
pnpm eval                # detection-quality gate against committed fixtures
pnpm eval holdout        # anti-overfit gate against held-out fixtures
pnpm eval accept         # real-bin 1D-curve gate (skips without local firmware)
pnpm dev                 # desktop app (first run compiles Rust — minutes)
```

`pnpm eval` scores discovered BIN/ground-truth pairs, including the available
full and partial reference sets. `pnpm eval holdout` checks separate synthetic
seeds. `pnpm eval accept` adds dedicated real-image curve, partial and exact-layout
checks; see [fixtures/README.md](fixtures/README.md) for the inputs each requires.
Real firmware stays local and missing files are reported as skips. A CI pass
without those files does not establish coverage of an untested ECU or revision.

Building an installer needs the Rust toolchain and the
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/); see the README.

For a new ECU family, start with [Developing ECU families](FAMILY_DEVELOPMENT.md).
It includes executable checksum and detection examples, the extension contracts,
registration, evaluation and build instructions.

## Package boundaries

Dependencies flow one way. A violation is a bug, not a style preference.

| Package | Role | May depend on |
|---|---|---|
| `packages/core` | Types, codecs, scaling, validation | nothing |
| `packages/engine` | Detection pipeline — **pure**: no fs, no DOM, no Node APIs | core |
| `packages/formats` | RomRaider XML, XDF, CSV/JSON, project file — **pure** | core |
| `packages/families` | Image identity and checksum verification/correction — **pure** | core |
| `packages/appkit` | Cross-surface adapter helpers — **pure** | core, engine, formats |
| `packages/eval` | Quality harness, Node CLI | core, engine, formats, families |
| `apps/desktop` | Tauri 2 + Svelte 5 UI | everything |
| `apps/mcp` | Stdio server | everything |

File I/O lives only in `apps/*` and `packages/eval`. No package may import from
an app.

## Non-negotiables

**Tests first.** Write the failing test, watch it fail for the right reason,
then implement. Config or type plumbing needed to make a test compile may come
first; behaviour never does.

**The engine is deterministic.** No `Math.random()`, no `Date`, no ambient
input. The same bytes must always produce the same maps — the eval harness,
the parity digests and the companion server's independent re-scan all depend
on it.

**Heuristic constants live in one file.** Every threshold, window, floor and
ratio belongs in `packages/engine/src/config.ts`, with a comment recording what
was measured to justify its value. A magic number inline in a detection module
is a defect.

**Detection changes require `pnpm eval`.** Report the score movement in the
commit message. All applicable quality gates must pass.

**Never relax a gate to make a change fit.** Thresholds are ratchets: they move
up when quality improves and never down. Special-casing a fixture, loosening an
assertion, or tuning against the holdout set defeats the entire harness. If a
change cannot meet the gate, the honest outcome is to document the finding and
stop — that is a successful contribution, not a failed one.

**Fixtures change only when the generator changes.** Synthetic fixtures are
regenerated exclusively via `pnpm eval gen-synthetic` (seeded, deterministic).
Never hand-edit one.

**Never commit ECU firmware.** Real bins are copyrighted and are gitignored.
Ground truth derived from third-party definition files must contain structure
only — see [fixtures/README.md](fixtures/README.md).

**Edits use the existing journal and save path.** The app supports byte editing,
undo/redo, checksum correction and verified file saves. Preserve the original
image, record byte changes through the shared editing owners, and let the save
path perform supported correction and read-back verification. Family functions
must not mutate their input buffers or perform file I/O. A checksum that cannot
be safely corrected stays report-only; unknown coverage must remain explicit.

**New runtime dependencies need justification.** The dependency surface is
small on purpose. Build and test tooling is less restricted.

## Reading the comments

Detection code cites its evidence in two forms you will not find in this
repository:

- `spec §4.3` — sections of an internal design document.
- Measurement notes and temporary experiments that established a decision.

These are development records, kept out of the distributed source. **They are
provenance, not the explanation**: wherever a constant, threshold or tier
placement is cited this way, the measured justification is stated inline in the
same comment — what was measured, on which fixtures, and what moved. If you
ever find a value whose reasoning exists *only* behind such a citation, that is
a documentation bug worth reporting; the comment should stand on its own.

The authoritative, reproducible statement of detection quality is not a
document at all — it is `pnpm eval` and `pnpm eval holdout`, which anyone can
run against the committed fixtures.

## Before you open a pull request

Run the whole ladder and make sure it is green:

```sh
pnpm test
pnpm typecheck
pnpm eval
pnpm eval holdout
pnpm eval accept
```

Stop if any command fails. Then check `git status` — only the files your change
intends to touch should appear.

## Commit messages

Conventional-commit style: `type(scope): imperative summary`, e.g.
`fix(engine): reject axis runs that cross the frame seam`. Explain *why* in the
body, and include measured numbers when the change touches detection.

## Reporting bugs

Detection bugs are much easier to fix with specifics: the ECU family, the bin
size, the address of the map that was missed or mis-framed, and what you
expected instead. Please do not attach firmware images — an address and a
description are enough, and firmware may not be yours to share.
