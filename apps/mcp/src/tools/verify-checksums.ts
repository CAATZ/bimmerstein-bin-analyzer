import { checksumsFor } from '@binanalyzer/families';
import { asArgs, reqString } from '../args.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';

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
    if (mod === undefined) {
      return ok({
        familyId: null,
        applies: false,
        valid: false,
        blocks: [],
        skipped: [],
        notes: [`No family module recognised this image (${entry.bytes.length} bytes).`],
      });
    }
    return ok(mod.verify(entry.bytes));
  },
};
