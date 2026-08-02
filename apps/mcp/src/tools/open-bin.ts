import { createBinImage } from '@binanalyzer/core';
import { isMs41FullRead } from '@binanalyzer/appkit';
import { asArgs, reqString } from '../args.js';
import { err, ok, type ToolSpec } from '../result.js';

export const openBinTool: ToolSpec = {
  name: 'open_bin',
  description:
    'Read an ECU .bin file into the session and return its content-addressed binId (the sha256 of the file). Every other tool takes that binId. Idempotent: the same bytes always yield the same id, so re-opening is free. READ-ONLY — this server never writes a bin byte under any configuration.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Absolute or cwd-relative path to the .bin file.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const path = reqString(a, 'path');
    if (!path.ok) return err(path.error);

    const read = deps.io.readBin(path.value);
    if (!read.ok) return err(read.error);

    const image = createBinImage(read.value.bytes, read.value.name);
    const opened = await deps.store.open({
      binId: image.sha256,
      sha256: image.sha256,
      name: image.name,
      path: read.value.resolvedPath,
      size: image.size,
      isFullRead: isMs41FullRead(image.size),
      bytes: image.bytes,
    });
    const e = opened.entry;
    return ok({
      binId: e.binId,
      sha256: e.sha256,
      name: e.name,
      path: e.path,
      size: e.size,
      isFullRead: e.isFullRead,
      alreadyOpen: opened.alreadyOpen,
      ...(opened.evicted.length > 0 ? { evicted: opened.evicted.map((x) => x.binId) } : {}),
    });
  },
};
