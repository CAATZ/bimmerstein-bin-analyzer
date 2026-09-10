# Developing ECU families

This guide describes the extension contracts used by BimmerStein Bin Analyzer
0.2.18. The application edits saved files; it does not communicate with an ECU.

## Choose the extension you need

| Goal | Implementation | Rebuild the app? |
|---|---|---|
| Recognize an image, read its calibration ID, verify/correct checksums | A JavaScript family module loaded through **Families → Add module** | No |
| Find maps through family-specific headers, pointers or firmware code | A TypeScript `FamilyAnalyzer` registered in the engine | Yes |
| Include a family in the shipped distribution | Built-in registries and capability coverage records | Yes |
| Name maps or apply units/conversions using an existing definition | Import a matching definition or edit map properties | No |

A checksum module does not add a detector. Detection does not establish
checksum coverage, map names, physical units, or proof that every map was found.
The [user manual](manual/USER_MANUAL.md#15-family-modules-and-session-sharing)
covers the Families dialog for users.

## Set up and run the examples

Install the [build prerequisites](README.md#prerequisites), clone the repository,
and run these commands from its root. Corepack selects the pnpm version pinned
in `package.json` (9.15.0 for this source).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter desktop test -- family-examples
corepack pnpm typecheck
```

The focused command runs four checks using the real desktop module loader,
the supplied CRC helper, and the engine's map emitter. Test data is created in
memory; no firmware or additional dependency is needed. Typecheck also checks
the imported TypeScript analyzer example.

Two complete examples are provided:

- [demo-checksums.js](examples/families/demo-checksums.js): a loadable module.
- [demo-analyzer.ts](examples/families/demo-analyzer.ts): a compiled detector.

They implement an invented **BFAM v1** file format, not an actual ECU family.
They are not registered in the application. The
[example tests](apps/desktop/test/family-examples.test.ts) contain the complete
sample-image constructor and demonstrate both APIs.

### Synthetic example layout

All offsets are hexadecimal byte offsets into a 128-byte file. End positions
are exclusive. Words are unsigned, 16-bit, little-endian.

| Offset | Meaning |
|---|---|
| `0x00..0x04` | ASCII `BFAM` signature |
| `0x04` | Format version: `1` |
| `0x05` | Calibration identifier byte; sample value `7` |
| `0x06`, `0x07` | Row count, column count; sample `4`, `6` |
| `0x08`, `0x0A`, `0x0C` | Word pointers to X breakpoints, Y breakpoints and first table cell |
| `0x10..0x7E` | Available axis/table storage |
| `0x7E..0x80` | Stored CRC-16/ARC of bytes `[0, 0x7E)`, initial value `0` |

The sample places six column breakpoints at `0x20`, four row breakpoints at
`0x2C`, and 24 word cells at `0x34`. The table occupies `[0x34, 0x64)` in
row-major order. Its first row contains `1000, 1010, 1020, 1030, 1040, 1050`.
These numbers are raw demonstration values with no automotive units.

## Loadable identity and checksum modules

### File format and available helper

A module is a `.js` **function body** whose final statement returns an object:

```js
return { familyId, applies, identify, verify, correct };
```

Use ordinary synchronous JavaScript. Do not use `export default`, `module.exports`,
imports, TypeScript syntax or asynchronous methods in this file. The loader
passes an argument named `bin`; this is a helper object, not the loaded image.
Each method receives the image as its own `Uint8Array` argument.

The only supplied helper is `bin.crc16(bytes, init)`, implementing CRC-16/ARC
with reflected polynomial `0xA001`. For disjoint covered ranges, pass the previous
result as the next initial value in the algorithm's defined order. Use it only
when the target firmware's checksum algorithm actually matches.

The [loader](apps/desktop/src/lib/familyloader.ts) evaluates executable code and
checks the returned object's required member types. It is not a sandbox and
does not prove a module's calculations or returned ranges are correct. Keep
modules pure and load only reviewed source you trust.

### Required contract

The complete types are in [families/types.ts](packages/families/src/types.ts).

| Member | Required behavior |
|---|---|
| `familyId` | Stable, non-empty string; use your own identifier |
| `applies(bytes)` | Cheap structural recognition; false for unsupported lengths, layouts and revisions |
| `identify(bytes)` | `{ familyId, calId }` read from recognized bytes, or `undefined` when unknown |
| `verify(bytes)` | A complete `ChecksumReport`, without changing input |
| `correct(bytes)` | `{ bytes, report, changed }` containing a new buffer, its verification report and exact byte changes |

An invalid checksum should usually still pass structural recognition: it is
the condition verification reports and supported correction repairs. Do not
claim a family from file size alone, and do not invent a calibration identifier
from the filename. If only some firmware revisions are supported, reject the
others before reading or changing their data.

A report contains `familyId`, `applies`, `blocks`, `valid`, `skipped`, and
`notes`. Each evaluated block contains:

- `id`, `label`, `covers: [{ start, end }]`, and `storedAt`.
- Numeric `stored` and `computed` values, plus `ok` and `correctable` booleans.

Every address is a **file offset**, and each covered interval excludes its end.
`valid` is true only when at least one block was evaluated and all evaluated
blocks match, including blocks the module cannot correct. Use `correctable: false`
for a checksum that is evaluated but never written. Use `skipped: [{ id, reason }]`
for an absent checksum, such as a program region missing from a calibration-only
dump. Do not represent unknown coverage as a verified empty list.

Correction must preserve the input, file length and every byte it is not
authorized to correct. Return each actual change as `{ offset, from, to }`;
report byte changes rather than changed word counts. Re-verify the output.
Correcting an already-correct image should produce no changes. The example
shows how to copy a typed-array view without accidentally mutating its backing
buffer, and how to report a two-byte stored CRC precisely.

The application owns saving and read-back verification. A module writes no
files and does not bypass the distinction between correctable, report-only and
unchecked regions in the [save report](apps/desktop/src/lib/savereport.ts).

### Install, reload and remove

1. Copy and adapt `demo-checksums.js` for your proven file layout, then test it.
2. In the app, open **Families → Add module** and select your `.js` file.
3. Confirm the family ID appears. Open a supported test image and inspect its
   checksum details. A listed module can still reject the current image.
4. After editing the module file, use **Reload** to read it again.

Alternatively, put one `.js` file in the `families` folder shown in the dialog
and reload. That folder is under the application's local data directory.
Use one loading route per module to avoid duplicates. The remove control forgets
an explicitly added path; it does not delete the source file. A file discovered
in the displayed folder must be moved out or deleted before reloading to unload it.

Built-in modules are checked first, then loaded modules; the first matching
module wins. A loaded module cannot override an image already recognized by a
built-in module. Runtime module IDs do not need entries in `FAMILY_IDS`.
Desktop loading does not install the module into the standalone companion
server or the evaluation CLI.

## Compiled map-detection analyzers

The contract is [FamilyAnalyzer](packages/engine/src/family/types.ts):

```ts
interface FamilyAnalyzer {
  id: string;
  analyze(bytes: Uint8Array, prefixedAxes: PrefixedAxis[], config: ScanConfig): FamilyDetection[];
}
```

The engine calls registered analyzers during every scan. They must be pure,
deterministic, preserve input bytes, and return `[]` quickly for other families.
Unsupported or truncated images are ordinary inputs, not exceptional cases.
The engine does not wrap analyzers in the desktop module's exception guard.

The example reads dimensions and pointers from its synthetic header, checks
word alignment, bounds and overlapping spans, and returns one map. Its pointers
already are file offsets. It respects the configured dimension limits, uses
the existing structural confidence setting, and rejects spans that reach the
stored checksum. It does not require a valid CRC to analyze an edited image.

### Addresses, layout and axes

For every emitted detection:

- `address` points to the **first data cell**, excluding headers, prefixes,
  embedded counts and axis arrays.
- `rows`, `cols`, `format.width`, `format.signed` and `format.endianness` describe
  the stored cells. `format.float` is optional and requires width 4.
- `xAxis.count` matches columns and `yAxis.count` matches rows for a grid. Axis
  addresses point to the first breakpoint, excluding any count prefix. Axis
  formats can differ from the table's cell format.
- Omit an unproven axis; do not attach a nearby monotone sequence as fact.
- Validate every data/axis span against the actual input length before reading
  or emitting it. Include the byte width in all span calculations.

For the demo, cell `(row, col)` is at `0x34 + (row * 6 + col) * 2`.
`0x34` is the data pointer; `0x0C` is the location of that pointer in the header.
The X axis ends at `0x2C`, exactly where Y starts; adjacent end-exclusive spans
do not overlap. Test one-byte errors as well as word-sized errors.

CPU addresses, banked addresses and calibration-relative addresses are not
interchangeable with file offsets. Define and test the conversion for each
supported image framing. A calibration-only file can lack the program code
needed for pointer tracing. Reject out-of-image pointers and unsupported frames;
never reuse the MS41 address mapping for an unrelated family.

The current family emitter creates **row-major** maps with raw identity scaling
and generated names. `FamilyDetection` has no field for custom names, units,
scaling or storage orientation. Describe the actual contiguous stored dimension
as columns and bind its axis accordingly; display transposition is separate.
Layouts that cannot be represented this way require a deliberate contract and
emitter change with tests. Import a matching definition or use map properties
for proven names and physical conversions.

`score` is a confidence value from 0 to 1; `tier` controls precedence and overlap
selection. The example's tier 0 describes its exact synthetic header, not a
general confidence rule for real firmware. Inspect
[score.ts](packages/engine/src/score.ts) before choosing tiers: grid results
claim spans before the generic candidates, and `kind: 'param'` has a separate
final pass. Never raise a tier merely to displace a better-established map.
New heuristic thresholds belong in [config.ts](packages/engine/src/config.ts),
with measured justification. File-format constants are not tuning thresholds.

### Add a built-in family

1. Create `packages/engine/src/family/<family>/analyzer.ts` implementing the
   interface. If adapting the example, change its type import to `../types.js`.
2. Import the analyzer into [family/index.ts](packages/engine/src/family/index.ts)
   and append it to `FAMILY_ANALYZERS`, retaining existing analyzers.
3. Add the stable ID to `FAMILY_IDS` in [core/types.ts](packages/core/src/types.ts).
4. Implement identity/checksums under `packages/families/src/<family>/` and add
   the object to `FAMILY_CHECKSUMS` in [families/index.ts](packages/families/src/index.ts).
   Built-ins use TypeScript exports and explicit imports, unlike loadable files.
   Neither pure package may import the other; both can depend on core.
5. Keep [detection coverage](packages/engine/test/family-coverage.test.ts) and
   [checksum coverage](packages/families/test/registry.test.ts) consistent.
   An intentionally unsupported capability must be documented in the existing
   explicit opt-out list with its reason; do not provide a fake successful implementation.
6. Add unit and full-scan tests, evaluate against independent ground truth,
   then rebuild. Merely placing a file in the source directory does not register it.

The examples remain outside these registries so the shipped detector and ECU
support do not change when someone runs the documentation tests.

## Validate a real family

Start from independent layout evidence and exact-image hashes. Define supported
revisions, image lengths, pointer framing, storage order, signedness and byte
order before attempting checksum correction or map recovery.

At minimum, check:

- Wrong family/version, truncation, invalid counts/pointers, overlaps and bank boundaries.
- Exact data starts, dimensions, formats and both known axes; include deliberately
  swapped axes and one-byte pointer errors. Square tables alone cannot expose all swaps.
- Deterministic output and unchanged input, including typed-array views with a
  nonzero byte offset. Check full scans as well as direct analyzer results so
  overlap ranking cannot silently discard correct candidates.
- Checksum matches and mismatches, report-only/absent blocks, correction
  idempotence, exact changed-byte records and preservation of unrelated bytes.
- Existing-family and synthetic results, plus a held-out image or calibration
  not used to develop the detector. Report runtime and false-positive movement.

Real BINs stay local in `fixtures/<family>/`; reference definitions stay in its
ignored `defs` directory. Place `<name>.groundtruth.json` beside `<name>.bin`,
binding `binSha256` to that exact image. Commit only permitted structural metadata,
never the firmware or third-party names, descriptions and scaling content.
See [fixture instructions](fixtures/README.md) and the
[ground-truth type](packages/eval/src/groundtruth.ts).

For a supported RomRaider definition whose addresses already match the BIN frame:

```sh
corepack pnpm eval gt-from-romraider fixtures/example/defs/reference.xml fixtures/example/reference.bin --fixture example-reference --id-prefix example --rom EXAMPLE_ROM
```

Replace the example paths and ROM identifier with actual inputs. Inspect every
warning and verify the resulting addresses against the image. `--fo` specifically
applies MS41 full-read framing; it is not a universal full-ROM switch. The existing
importer must support the definition and frame before this command is appropriate.

Run these separately and stop at the first failure:

```sh
corepack pnpm --filter @binanalyzer/engine test
corepack pnpm --filter @binanalyzer/families test
corepack pnpm typecheck
corepack pnpm test
corepack pnpm eval
corepack pnpm eval holdout
corepack pnpm eval accept
```

`eval` discovers reference pairs, but a new fixture name does not automatically
acquire an enforced quality threshold. Add measured acceptance requirements in
the evaluation harness for the new family; do not report an ungated row as an
acceptance pass. Preserve existing thresholds and fixtures. `eval accept` remains
MS41-focused until deliberately extended, and missing local firmware is a skip.
Synthetic generators are changed and regenerated through `pnpm eval gen-synthetic`;
never hand-edit the committed synthetic BINs to satisfy a test.

## Build and check the application

A loadable JavaScript module needs no compilation. A registered analyzer or
built-in family requires rebuilding the source containing that registration.
Use `dev` while developing, then stop it before running the packaging command.

```sh
corepack pnpm dev
corepack pnpm --filter desktop tauri build
```

The Windows alternative is `build-installer.cmd` from the repository root.
The MSI and NSIS installers are produced under
`apps/desktop/src-tauri/target/release/bundle/`; the standalone executable is
`apps/desktop/src-tauri/target/release/desktop.exe`. Building does not install
the app, publish a release, or change the already-installed executable.

Check the packaged build using copies of known files: supported and unsupported
BINs, detection addresses, axis units after definition import, a reversible edit,
undo, Save As, checksum details and read-back verification. Keep the original
file unchanged and verify the exact artifact/version you intend to distribute.
Offline tests establish software behavior; they do not prove safe vehicle operation.
