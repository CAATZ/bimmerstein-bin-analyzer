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

## Adding a real-bin fixture locally

1. Drop `yourbin.bin` into `fixtures/<family>/`.
2. Build `groundtruth.json` with
   `pnpm eval gt-from-romraider <def.xml> <bin> --fixture <name> --id-prefix <prefix> --rom <xmlid> --fo`
   (for MS41; see the Rules section above).
3. `pnpm eval` — the harness picks up any directory containing both files.
