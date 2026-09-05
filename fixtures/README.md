# Fixtures

Ground-truth fixtures for the detection eval harness (`pnpm eval`, spec §5).

## Layout

```
fixtures/
├── synthetic/   # committed: generated bins with planted maps + groundtruth.json (CI-safe)
└── ms41/        # local-only real firmware (*.bin gitignored) + committed groundtruth.json
```

## Rules

- **Never commit real ECU firmware.** It is copyrighted. `.gitignore` blocks
  `fixtures/**/*.bin` except `fixtures/synthetic/`.
- **Ground-truth JSONs contain only structure** — addresses, dimensions,
  formats and axis bindings, keyed to the bin by sha256. This is enforced by
  the generator, not by convention: `gt-from-romraider` reduces every row to
  the fields the eval harness actually consumes. Map and axis **names**, the
  **category** taxonomy, free-text **notes** and the reverse-engineered
  **scaling** are dropped (`name` becomes the structural id and `scaling`
  becomes identity, since `MapDef` requires both).
  That matters because these files are committed while the definition XML they
  are built from is not (see below) — ground truth must not become a back door
  that republishes the definition author's work.
- MS41 ground truth is generated from the user's RomRaider definition XML:
  `pnpm eval gt-from-romraider <def.xml> <bin> --fixture <name> --id-prefix <prefix> --rom <xmlid> --fo`
  (`--fo` applies the MS41 256KB full-read bus descramble; omit it for 24KB CAL
  dumps; paths may be absolute or repo-root-relative). Source def files go in
  a local `defs/` subfolder (gitignored — third-party licensing).
- Synthetic fixtures are regenerated ONLY via `pnpm eval gen-synthetic`
  (seeded, deterministic); never hand-edit them.

## What the MS41 real-bin fixtures actually are

Their filenames are not reliable descriptions — read this before drawing any
conclusion from which fixture a result came from.

| file | what it really is |
|---|---|
| `E36 M3 Stock Full Read.bin` | genuinely stock **MS41.2**, romid CAL-ID `12`. Every checksum verifies. |
| `MS41.3 S52 Stock Full Read.bin` | **MS41.3, but NOT stock** — SS1v2-patched, with its checksums left stale and the ECU's boot-verification switch turned OFF (`0x605C = 0xFF`). Its romid still reads CAL-ID `12`. |

Both are S52-engine bins; the distinguishing axis is firmware, not car.

**MS41.3 is not a fourth factory variant.** It is community firmware derived from
official MS41.2 `1406464` — BMW ships no MS41.3 program — so its program layout
IS MS41.2's. Measured: 0.0 % / 0.1 % / 1.7 % byte divergence from the MS41.2
image across the three program-checksum regions, against 45.7 % / 88.6 % / 91.0 %
between two genuinely different factory variants (MS41.2 vs MS41.0). So the S52
fixture's program-checksum mismatch is a **stale stored value**, and this fixture
must not be cited as evidence about a distinct factory layout.

## Adding a real-bin fixture locally

Additional definition-matched references live under `fixtures/references/`:
MS41.0 calibration ID 41 (59 grids) and MS41.1 ID 60 (56 grids), each in full
and partial framing. Their ground truth binds the exact image hash; firmware
stays local and untracked. Published metadata contains only structure; names and
scaling remain in the local matching definition.

The ID41 truth retains all 59 grids and includes three independently checked
corrections to the older definition: starts `0x26A6` and `0x272E` replace
`0x26A0` and `0x272D`; the square grid at `0x0F1E` uses columns at `0x0758`
and rows at `0x075D`. These storage addresses agree with the matching factory
listing and firmware access paths. Full-read truth applies the usual address
conversion. Reference corrections are separate from detector score gains.

The ID60 full image also verifies all 18 checksum blocks, including a stored
and independently computed program checksum of `0x350F`. Its partial verifies
all 16 calibration blocks. To include these optional checksum acceptance cases,
copy the local full reference to `fixtures/ms41/reference-ms41-id60-full.bin`
and its partial to `fixtures/ms41/partial/reference-ms41-id60-partial.bin`.
The reference metadata binds their exact hashes. This is offline evidence;
the program checksum remains report-only and is never corrected on save.

Evaluation reports exact starts, exact layouts (including width, signedness,
byte order and storage order), and complete known-axis pairs alongside the
older overlap scores. Measured floors in `packages/eval/src/exact-gates.ts`
protect these properties in fixture evaluation, holdout and real acceptance.
Synthetic pool fixtures also require at most 2,500 unmatched detections per
100 KB of data. This precision ceiling applies alongside the recall floors;
real-image references remain uncapped because their truth is incomplete.

1. Drop `yourbin.bin` into `fixtures/<family>/`.
2. Build `groundtruth.json` with
   `pnpm eval gt-from-romraider <def.xml> <bin> --fixture <name> --id-prefix <prefix> --rom <xmlid> --fo`
   (for MS41; see the Rules section above).
3. `pnpm eval` — the harness picks up any directory containing both files.
