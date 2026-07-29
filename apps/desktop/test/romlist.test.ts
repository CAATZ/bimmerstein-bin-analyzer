import { describe, expect, it } from 'vitest';
import { listRomIds } from '../src/lib/romlist.js';

const MULTI = `<?xml version="1.0"?>
<roms>
  <rom><romid><xmlid>BMWMS41BASE</xmlid></romid></rom>
  <rom base="BMWMS41BASE"><romid><xmlid>12</xmlid></romid></rom>
  <rom base="BMWMS41BASE"><romid><xmlid>SS1v2</xmlid></romid></rom>
  <rom><romid><xmlid>12</xmlid></romid></rom>
</roms>`;

describe('listRomIds', () => {
  it('lists xmlids in document order, deduplicated', () => {
    expect(listRomIds(MULTI)).toEqual(['BMWMS41BASE', '12', 'SS1v2']);
  });

  it('returns a single id for single-rom docs', () => {
    expect(listRomIds(`<roms><rom><romid><xmlid>T1</xmlid></romid></rom></roms>`)).toEqual(['T1']);
  });

  it('returns [] for non-roms documents and garbage', () => {
    expect(listRomIds(`<xdf/>`)).toEqual([]);
    expect(listRomIds(`not xml at all`)).toEqual([]);
    expect(listRomIds(`<roms><rom><romid></romid></rom></roms>`)).toEqual([]);
  });
});
