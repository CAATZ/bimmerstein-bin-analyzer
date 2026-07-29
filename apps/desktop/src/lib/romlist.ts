import { parseXml } from '@binanalyzer/formats';

/**
 * Enumerate <rom>/<romid>/<xmlid> values so the UI can offer a rom picker
 * before calling importRomRaiderXml (which REQUIRES a romId on multi-rom
 * docs). Document order, deduplicated — mirrors the importer's own scan.
 */
export function listRomIds(xml: string): string[] {
  const parsed = parseXml(xml);
  if (!parsed.ok || parsed.value.name !== 'roms') return [];
  const ids: string[] = [];
  for (const rom of parsed.value.children) {
    if (rom.name !== 'rom') continue;
    const romid = rom.children.find((c) => c.name === 'romid');
    const xmlid = romid?.children.find((c) => c.name === 'xmlid')?.text;
    if (xmlid !== undefined && xmlid !== '' && !ids.includes(xmlid)) ids.push(xmlid);
  }
  return ids;
}
