import { checksumsFor, type ChecksumReport } from '@binanalyzer/families';
import { asArgs, reqString } from '../args.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

/**
 * What this tool returns when NO family module recognises the image.
 *
 * `ChecksumReport.familyId` is a `FamilyId`, so the no-module case cannot be
 * one: there is no family to name. Declaring the shape instead of writing a
 * bare object literal keeps the two payloads honest — a field added to
 * `ChecksumReport` now has to be considered here too, rather than silently
 * leaving agents with two different shapes for the same tool.
 */
type UnrecognisedReport = Omit<ChecksumReport, 'familyId'> & { familyId: null };

const unrecognised = (size: number): UnrecognisedReport => ({
  familyId: null,
  applies: false,
  valid: false,
  blocks: [],
  skipped: [],
  notes: [`No family module recognised this image (${size} bytes).`],
});

export const verifyChecksumsTool: ToolSpec = {
  name: 'verify_checksums',
  description:
    'Verify the firmware checksums of an open bin. Returns a per-block report (stored vs computed), the blocks deliberately not evaluated and why, and advisory notes. Read-only: this never modifies the bin. `valid` covers only the checksums the family module stands behind — on MS41 the program checksum is reported but never vouched for.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);

    const entry = await deps.store.get(id.value);
    if (entry === undefined) return await unknownBin(deps, id.value);

    const mod = checksumsFor(entry.bytes);
    if (mod === undefined) return ok(unrecognised(entry.bytes.length));
    return ok(mod.verify(entry.bytes));
  },
};
