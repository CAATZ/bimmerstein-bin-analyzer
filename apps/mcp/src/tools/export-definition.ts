import type { MapDef, Result } from '@binanalyzer/core';
import { unframeDefMaps } from '@binanalyzer/appkit';
import { exportMapListCsv, exportMapListJson, exportRomRaiderXml, exportXdf, type RomRaiderExportOptions } from '@binanalyzer/formats';
import { MCP_CONFIG } from '../config.js';
import { asArgs, optAddress, optEnum, optString, reqString } from '../args.js';
import { sourcedMaps } from '../maps.js';
import { err, ok, unknownBin, type ToolSpec } from '../result.js';
import { resolveWriteTarget } from '../writeguard.js';

const FORMATS = ['romraider', 'xdf', 'csv', 'json'] as const;

export const exportDefinitionTool: ToolSpec = {
  name: 'export_definition',
  description:
    'Serialize maps as a RomRaider XML definition, a TunerPro XDF, or a CSV/JSON map list. By default the text comes back in the result. An outPath is honored ONLY if this server was started with --allow-write <dir> and the resolved real path is inside that root — bin files are never written under any configuration. RomRaider export on an MS41 full read converts file offsets back to storageaddresses; maps with no exact storageaddress representation are skipped and listed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['binId', 'format'],
    properties: {
      binId: { type: 'string', description: 'sha256 handle from open_bin.' },
      format: { enum: [...FORMATS] },
      source: { enum: ['imported', 'potential', 'ids'], default: 'imported' },
      mapIds: { type: 'array', items: { type: 'string' }, description: 'Required when source is "ids".' },
      romId: { type: 'string', description: 'romraider only; defaults to the imported rom id, else the bin name.' },
      title: { type: 'string', description: 'xdf only; defaults to the bin name.' },
      internalIdAddress: { type: ['integer', 'string'], description: 'romraider only.' },
      internalIdString: { type: 'string', description: 'romraider only.' },
      outPath: { type: 'string', description: 'Write here instead of returning the text. Requires --allow-write.' },
    },
  },
  async handle(raw, deps) {
    const a = asArgs(raw);
    const id = reqString(a, 'binId');
    if (!id.ok) return err(id.error);
    if (a['format'] === undefined) return err(`"format" is required — one of: ${FORMATS.join(', ')}`);
    const format = optEnum(a, 'format', FORMATS, 'romraider');
    if (!format.ok) return err(format.error);
    const source = optEnum(a, 'source', ['imported', 'potential', 'ids'] as const, 'imported');
    if (!source.ok) return err(source.error);
    const romId = optString(a, 'romId');
    if (!romId.ok) return err(romId.error);
    const title = optString(a, 'title');
    if (!title.ok) return err(title.error);
    const internalIdString = optString(a, 'internalIdString');
    if (!internalIdString.ok) return err(internalIdString.error);
    const internalIdAddress = optAddress(a, 'internalIdAddress');
    if (!internalIdAddress.ok) return err(internalIdAddress.error);
    const outPath = optString(a, 'outPath');
    if (!outPath.ok) return err(outPath.error);

    const entry = deps.store.get(id.value);
    if (entry === undefined) return unknownBin(deps, id.value);

    const skipped: string[] = [];
    let maps: MapDef[];
    if (source.value === 'ids') {
      const wanted = a['mapIds'];
      if (!Array.isArray(wanted) || wanted.some((x) => typeof x !== 'string')) {
        return err('"mapIds" must be an array of strings when source is "ids"');
      }
      const pool = sourcedMaps(entry, 'all');
      if (!pool.ok) return err(pool.error);
      const index = new Map(pool.value.map((sm) => [sm.map.id, sm.map]));
      maps = [];
      for (const want of wanted as string[]) {
        const hit = index.get(want);
        if (hit === undefined) skipped.push(`unknown mapId "${want}"`);
        else maps.push(hit);
      }
    } else {
      const pool = sourcedMaps(entry, source.value);
      if (!pool.ok) return err(pool.error);
      maps = pool.value.map((sm) => sm.map);
    }

    // RomRaider speaks storageaddresses. On a full read, invert the import
    // framing exactly; a map with no SA representation is skipped loudly.
    // XDF/CSV/JSON stay in file-offset space, matching the desktop.
    let unframed: 'fo->sa' | 'none' = 'none';
    if (format.value === 'romraider' && entry.isFullRead) {
      const back = unframeDefMaps(maps);
      maps = back.maps;
      skipped.push(...back.skipped);
      unframed = 'fo->sa';
    }

    const name = entry.name.replace(/\.bin$/i, '');
    let text: Result<string>;
    if (format.value === 'romraider') {
      const options: RomRaiderExportOptions = {
        ...(internalIdAddress.value !== undefined ? { internalIdAddress: internalIdAddress.value } : {}),
        ...(internalIdString.value !== undefined ? { internalIdString: internalIdString.value } : {}),
      };
      text = exportRomRaiderXml(romId.value ?? entry.imported?.romId ?? name, maps, options);
    } else if (format.value === 'xdf') {
      text = exportXdf(title.value ?? name, entry.size, maps);
    } else if (format.value === 'csv') {
      text = exportMapListCsv(maps);
    } else {
      text = exportMapListJson(maps);
    }
    if (!text.ok) return err(`export failed: ${text.error}`);

    const body = {
      binId: entry.binId,
      format: format.value,
      source: source.value,
      maps: maps.length,
      skipped,
      unframed,
      bytes: Buffer.byteLength(text.value, 'utf8'),
    };

    if (outPath.value !== undefined) {
      const target = resolveWriteTarget(deps.writeRoot, outPath.value);
      if (!target.ok) return err(target.error);
      const written = deps.io.writeText(target.value, text.value);
      if (!written.ok) return err(written.error);
      return ok({ ...body, writtenTo: target.value });
    }

    if (text.value.length > MCP_CONFIG.exportMaxInlineChars) {
      return err(
        `the ${format.value} export is ${text.value.length} characters, over the ${MCP_CONFIG.exportMaxInlineChars} inline cap. Pass "outPath" (the server must be started with --allow-write <dir>), or narrow the selection with source:"ids" and mapIds. A truncated definition is never returned.`
      );
    }
    return ok({ ...body, content: text.value });
  },
};
