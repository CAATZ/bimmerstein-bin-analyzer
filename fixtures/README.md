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
  **category** taxonomy, free-text **notes**, named **states** and the reverse-engineered
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

The separate `reference-ms41-id41-catalog-*` references expand the ID41 benchmark
to the complete matched factory catalog: 110 grids, 140 curves/arrays and 420
scalars in each address frame. The existing 59-grid subset is unchanged.
`buildCatalogGroundTruth` takes explicitly selected imported objects and retains
uniform values, signed formats and static axes; it rejects duplicate starts and
invalid spans. Selection uses the source catalog and the matching definition's
adjudication ledger, never detector output. Scans receive only the binary.

The source listing SHA-256 is
`d51a47a8cc33dea10e6342acedd6b9b2f4cccf58526a37675997bd61a262fb1d`;
the matching humanized definition SHA-256 is
`5ba19b65fb16c2affe0c966a2f9da465d27d6a6b134905f965892b2e9fc068bd`.
Each fixture binds its full or partial binary hash. Full and partial calibration
bytes agree after address conversion. Scalar references remain present for
partial files even though code-based scalar recovery requires a full ROM;
their current zero recall is reported explicitly. Catalog membership proves
reference coverage, not firmware consumption or physical tuning behavior.
Scalar classes use exact-start and exact-layout gates; the older overlap gate's
axis requirement applies to grids and curves, which have axes to recover.

The `reference-ms41-{ss1v2,id60,id12}-expanded-*` references cover the broader
definition audit for three additional firmware images. Each class has full-read
and calibration-only metadata:

| Firmware | Grids | Curves/arrays | Scalars | Addressed source entries |
|---|---:|---:|---:|---:|
| MS41.3 SS1v2 | 100 | 137 | 187 | 426 |
| MS41.1 ID60 | 71 | 94 | 449 | 618 |
| MS41.2 ID12 | 73 | 108 | 163 | 347 |

The 1,391 source entries resolve to 1,382 distinct valid benchmark objects:
six aliases and three legacy axis views with ambiguous axis roles are accounted
for separately; those views cannot be canonicalized into valid benchmark curves.
Selection follows the definition audit, independently of detection. These are
definition coverage counts, not proof that every firmware map has been found.
The source definition SHA-256 is
`b74a726920f7179950d2323e55982ed3dbada7dca18f22d27ab4e60470a9ac45`;
its adjudication ledger SHA-256 is
`0d7b3efd473204cfd64a0850654e1f2d417efc4c069f72507d61519726f91a10`.
The reference remains untested on hardware.

Exact-image regression tests also protect the fifteen recovered cached byte
parameters and seven runtime grid layouts or axis bindings at their individual
addresses. These checks verify the full-image hash before scanning, so an
unrelated detection gain cannot hide a regression at a protected address.
They skip explicitly when the corresponding local firmware is absent.

Five additional hash-pinned MS41 ID42/ID59 images protect MAF word width and
placeholder-axis handling. Optional files live at `fixtures/maf/id<rom>-<hash8>.bin`
with the audited definition at `fixtures/maf/defs/reference.xml`; exact hashes
are recorded in `packages/eval/test/maf-references.test.ts`. Each check derives
a calibration-only view from its full image and verifies both 256-point and
16×16 definition views against the same 512 data bytes. These derived partials
are not independent captures. Tests skip explicitly when local inputs are absent.

The SS1v2 partial for this expanded set is extracted from the matching full ROM;
the older, independently supplied partial differs at 20 bytes and remains in
the earlier acceptance cases. The expanded ID60 full image is a different
hash-bound capture from the older grid subset. All three expanded full/partial
pairs have identical calibration bytes after address conversion. Partial scalar
classes retain their zero recovery floors because their files contain no code.

1. Drop `yourbin.bin` into `fixtures/<family>/`.
2. Build `groundtruth.json` with
   `pnpm eval gt-from-romraider <def.xml> <bin> --fixture <name> --id-prefix <prefix> --rom <xmlid> --fo`
   (for MS41; see the Rules section above).
3. `pnpm eval` — the harness picks up any directory containing both files.

## Exact layout acceptance

`ms41/acceptance/` contains structural records for five exact ID41/ID59 images.
Place each local BIN beside its matching record, using the same stem. Run
`pnpm eval accept` to verify all 23 data layouts and axis pairs, independently
of any definition XML. These cases cover two distinct ID41 partial calibrations
(six grids and three curves each), one ID41 full-image curve, and two curves
in each of two ID59 full images. Widths and starts were checked against the
matching calibration reference and firmware reader paths.

Every present BIN must match its recorded SHA-256. Missing BINs are reported as
skips; missing or invalid truth and any address, width, or axis drift fail.
Records contain structural metadata only; firmware remains untracked.
