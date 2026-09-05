import { describe, expect, it } from 'vitest';
import type { MapDef, Project } from '@binanalyzer/core';
import { parseProject, serializeProject } from '../src/project-file.js';

const SHA = '2d3ab7db6fe0f9a1f4680339f416aeeef43871730cd468cfd990f6dc80c03208';

function confirmedMap(): MapDef {
  return {
    id: 'm1', name: 'Ign', address: 0x100, rows: 4, cols: 4,
    format: { width: 2, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'imported',
    xAxis: { kind: 'referenced', address: 0x80, count: 4, format: { width: 1, signed: false, endianness: 'little' } },
  };
}

function autoMap(): MapDef {
  return {
    id: 'p1', name: 'candidate', address: 0x200, rows: 2, cols: 8,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'auto', confidence: 0.5,
  };
}

function switchMap(): MapDef {
  return {
    id: 's1', name: 'Flex Fuel Enable', address: 0x300, rows: 2, cols: 1,
    format: { width: 1, signed: false, endianness: 'little' },
    scaling: { factor: 1, offset: 0, units: '', digits: 0 },
    orientation: 'row-major', provenance: 'imported',
    states: [
      { name: 'Off', data: [0, 0] },
      { name: 'On', data: [1, 0] },
    ],
  };
}

function sampleProject(): Project {
  return {
    schemaVersion: 3,
    bin: { name: 'test.bin', sha256: SHA, size: 0x1000 },
    valueDefaults: { width: 2, signed: false, endianness: 'big' },
    maps: [confirmedMap()],
    potentialMaps: [autoMap()],
  };
}

describe('serializeProject / parseProject', () => {
  it('rejects invalid float flags in every value-format position', () => {
    for (const format of [
      { width: 2, signed: false, endianness: 'little', float: true },
      { width: 4, signed: false, endianness: 'little', float: 'false' },
    ]) {
      const p = sampleProject();
      expect(parseProject(JSON.stringify({ ...p, valueDefaults: format })).ok).toBe(false);
      expect(parseProject(JSON.stringify({ ...p, maps: [{ ...confirmedMap(), format }] })).ok).toBe(false);
      const map = confirmedMap();
      expect(parseProject(JSON.stringify({ ...p, maps: [{ ...map, xAxis: { ...map.xAxis, format } }] })).ok).toBe(false);
    }
  });

  it('rejects precision that would crash map rendering', () => {
    const p = sampleProject();
    p.maps[0]!.scaling.digits = 101;
    expect(parseProject(JSON.stringify(p)).ok).toBe(false);
  });

  it('rejects fractional map addresses instead of truncating them during reads', () => {
    const p = sampleProject();
    p.maps[0]!.address = 0.5;
    expect(parseProject(JSON.stringify(p)).ok).toBe(false);
  });

  it('round-trips deep-equal with a trailing newline', () => {
    const json = serializeProject(sampleProject());
    expect(json.endsWith('}\n')).toBe(true);
    const r = parseProject(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(sampleProject());
  });

  it('round-trips a switch map (states) deep-equal', () => {
    const p: Project = { ...sampleProject(), maps: [confirmedMap(), switchMap()] };
    const json = serializeProject(p);
    const r = parseProject(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(p);
  });

  it('is deterministic regardless of caller key order', () => {
    const shuffled = { potentialMaps: [autoMap()], maps: [confirmedMap()], valueDefaults: { width: 2, signed: false, endianness: 'big' }, bin: { size: 0x1000, sha256: SHA, name: 'test.bin' }, schemaVersion: 1 } as unknown as Project;
    expect(serializeProject(shuffled)).toBe(serializeProject(sampleProject()));
  });

  it('rejects newer schema versions with an actionable message', () => {
    const r = parseProject(serializeProject(sampleProject()).replace('"schemaVersion": 3', '"schemaVersion": 4'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('schemaVersion 4');
  });

  it('rejects invalid JSON, non-objects, bad bin identity and bad valueDefaults', () => {
    expect(parseProject('{oops').ok).toBe(false);
    expect(parseProject('42').ok).toBe(false);
    expect(parseProject('{"schemaVersion":1,"bin":null}').ok).toBe(false); // must not crash on null bin
    const noSha = { ...sampleProject(), bin: { name: 'x.bin', sha256: 'nope', size: 16 } };
    expect(parseProject(JSON.stringify(noSha)).ok).toBe(false);
    const badDefaults = { ...sampleProject(), valueDefaults: { width: 3, signed: false, endianness: 'big' } };
    expect(parseProject(JSON.stringify(badDefaults)).ok).toBe(false);
  });

  it('rejects maps that are not fully readable against the recorded bin size, naming the culprit', () => {
    const p = sampleProject();
    p.maps[0]!.address = 0xfff8; // 4×4×2 bytes no longer fit in 0x1000
    const r = parseProject(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('maps[0]');
  });

  it('rejects provenance in the wrong list (auto in maps, non-auto in potentialMaps)', () => {
    const wrongList = { ...sampleProject(), maps: [autoMap()], potentialMaps: [] };
    expect(parseProject(JSON.stringify(wrongList)).ok).toBe(false);
    const wrongList2 = { ...sampleProject(), maps: [], potentialMaps: [confirmedMap()] };
    expect(parseProject(JSON.stringify(wrongList2)).ok).toBe(false);
  });

  it('never throws on structurally broken map entries', () => {
    const broken = { ...sampleProject(), maps: [{ id: 'x' }] };
    const r = parseProject(JSON.stringify(broken));
    expect(r.ok).toBe(false);
  });

  it('rejects malformed nested scaling fields', () => {
    const missingFactor = sampleProject();
    const m1 = missingFactor.maps[0] as unknown as { scaling: Record<string, unknown> };
    delete m1.scaling.factor;
    expect(parseProject(JSON.stringify(missingFactor)).ok).toBe(false);

    const wrongOffset = sampleProject();
    (wrongOffset.maps[0] as unknown as { scaling: Record<string, unknown> }).scaling.offset = 'zero';
    expect(parseProject(JSON.stringify(wrongOffset)).ok).toBe(false);

    const wrongUnits = sampleProject();
    (wrongUnits.maps[0] as unknown as { scaling: Record<string, unknown> }).scaling.units = 42;
    expect(parseProject(JSON.stringify(wrongUnits)).ok).toBe(false);

    const wrongDigits = sampleProject();
    (wrongDigits.maps[0] as unknown as { scaling: Record<string, unknown> }).scaling.digits = null;
    expect(parseProject(JSON.stringify(wrongDigits)).ok).toBe(false);
  });

  it('rejects malformed axis internals instead of silently passing via NaN comparisons', () => {
    const badWidth = sampleProject();
    (badWidth.maps[0] as unknown as { xAxis: { format: Record<string, unknown> } }).xAxis.format.width = 'oops';
    const rBadWidth = parseProject(JSON.stringify(badWidth));
    expect(rBadWidth.ok).toBe(false);

    const badEndian = sampleProject();
    (badEndian.maps[0] as unknown as { xAxis: { format: Record<string, unknown> } }).xAxis.format.endianness = 'middle';
    expect(parseProject(JSON.stringify(badEndian)).ok).toBe(false);

    const badCount = sampleProject();
    (badCount.maps[0] as unknown as { xAxis: Record<string, unknown> }).xAxis.count = 'four';
    expect(parseProject(JSON.stringify(badCount)).ok).toBe(false);

    const missingAddress = sampleProject();
    delete (missingAddress.maps[0] as unknown as { xAxis: Record<string, unknown> }).xAxis.address;
    expect(parseProject(JSON.stringify(missingAddress)).ok).toBe(false);
  });

  it('rejects a literal axis with non-numeric or missing values', () => {
    const literalAxisMap: MapDef = {
      ...confirmedMap(),
      xAxis: { kind: 'literal', count: 4, values: [1, 2, 3, 4] },
    };
    const wrongValues = { ...sampleProject(), maps: [literalAxisMap] };
    (wrongValues.maps[0] as unknown as { xAxis: Record<string, unknown> }).xAxis.values = ['a', 'b', 'c', 'd'];
    expect(parseProject(JSON.stringify(wrongValues)).ok).toBe(false);

    const missingValues = { ...sampleProject(), maps: [literalAxisMap] };
    delete (missingValues.maps[0] as unknown as { xAxis: Record<string, unknown> }).xAxis.values;
    expect(parseProject(JSON.stringify(missingValues)).ok).toBe(false);
  });

  it('rejects malformed switch states shapes with an actionable message', () => {
    const emptyStates = { ...sampleProject(), maps: [switchMap()] };
    (emptyStates.maps[0] as unknown as { states: unknown }).states = [];
    const rEmpty = parseProject(JSON.stringify(emptyStates));
    expect(rEmpty.ok).toBe(false);
    if (!rEmpty.ok) expect(rEmpty.error).toContain('states must be a non-empty array');

    const notObjectEntry = { ...sampleProject(), maps: [switchMap()] };
    (notObjectEntry.maps[0] as unknown as { states: unknown }).states = ['nope'];
    const rNotObject = parseProject(JSON.stringify(notObjectEntry));
    expect(rNotObject.ok).toBe(false);
    if (!rNotObject.ok) expect(rNotObject.error).toContain('states entries must be objects');

    const emptyName = { ...sampleProject(), maps: [switchMap()] };
    (emptyName.maps[0] as unknown as { states: Array<Record<string, unknown>> }).states[0]!.name = '';
    const rEmptyName = parseProject(JSON.stringify(emptyName));
    expect(rEmptyName.ok).toBe(false);
    if (!rEmptyName.ok) expect(rEmptyName.error).toContain('state name must be a non-empty string');

    const stringData = { ...sampleProject(), maps: [switchMap()] };
    (stringData.maps[0] as unknown as { states: Array<Record<string, unknown>> }).states[0]!.data = ['ff'];
    const rStringData = parseProject(JSON.stringify(stringData));
    expect(rStringData.ok).toBe(false);
    if (!rStringData.ok) {
      expect(rStringData.error).toContain('state data must be a non-empty array of integers in [0, 255]');
    }

    const outOfRangeData = { ...sampleProject(), maps: [switchMap()] };
    (outOfRangeData.maps[0] as unknown as { states: Array<Record<string, unknown>> }).states[0]!.data = [300];
    const rOutOfRange = parseProject(JSON.stringify(outOfRangeData));
    expect(rOutOfRange.ok).toBe(false);
    if (!rOutOfRange.ok) {
      expect(rOutOfRange.error).toContain('state data must be a non-empty array of integers in [0, 255]');
    }

    const nonIntegerData = { ...sampleProject(), maps: [switchMap()] };
    (nonIntegerData.maps[0] as unknown as { states: Array<Record<string, unknown>> }).states[0]!.data = [2.5];
    const rNonInteger = parseProject(JSON.stringify(nonIntegerData));
    expect(rNonInteger.ok).toBe(false);
    if (!rNonInteger.ok) {
      expect(rNonInteger.error).toContain('state data must be a non-empty array of integers in [0, 255]');
    }
  });

  it('never throws on a structurally broken states value', () => {
    const broken = { ...sampleProject(), maps: [switchMap()] };
    (broken.maps[0] as unknown as { states: unknown }).states = 'not-an-array';
    expect(() => parseProject(JSON.stringify(broken))).not.toThrow();
    expect(parseProject(JSON.stringify(broken)).ok).toBe(false);
  });

  it('round-trips the optional addressFrame and omits it when absent', () => {
    const base: Project = {
      schemaVersion: 1,
      bin: { name: 'dump.bin', sha256: 'a'.repeat(64), size: 0x40000 },
      valueDefaults: { width: 2, signed: false, endianness: 'little' },
      maps: [],
      potentialMaps: [],
    };
    const withFrame: Project = { ...base, addressFrame: 'ms41full' };
    const framedJson = serializeProject(withFrame);
    expect(framedJson).toContain('"addressFrame": "ms41full"');
    const p1 = parseProject(framedJson);
    expect(p1.ok && p1.value.addressFrame === 'ms41full').toBe(true);
    const plainJson = serializeProject(base);
    expect(plainJson).not.toContain('addressFrame');
    const p2 = parseProject(plainJson);
    expect(p2.ok && p2.value.addressFrame === undefined).toBe(true);
  });

  it('rejects an invalid addressFrame value', () => {
    const bad = `{"schemaVersion":1,"bin":{"name":"d.bin","sha256":"${'a'.repeat(64)}","size":64},` +
      `"valueDefaults":{"width":1,"signed":false,"endianness":"little"},` +
      `"addressFrame":"weird","maps":[],"potentialMaps":[]}`;
    const r = parseProject(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('addressFrame');
  });
});

function libraryProject(): Project {
  const stamped: MapDef = {
    ...confirmedMap(),
    xAxis: {
      kind: 'referenced', address: 0x80, count: 4,
      format: { width: 1, signed: false, endianness: 'little' },
      name: 'RPM (main)', libId: 'lib-rpm',
    },
  };
  return {
    schemaVersion: 3,
    bin: { name: 'test.bin', sha256: SHA, size: 0x1000 },
    valueDefaults: { width: 2, signed: false, endianness: 'big' },
    axisLibrary: [
      {
        id: 'lib-rpm', name: 'RPM (main)',
        axis: { kind: 'referenced', address: 0x80, count: 4, format: { width: 1, signed: false, endianness: 'little' } },
        notes: 'knock cluster shared axis',
      },
      { id: 'lib-volts', name: 'Volts', axis: { kind: 'literal', count: 2, values: [0, 0.02] } },
    ],
    maps: [stamped],
    potentialMaps: [autoMap()],
  };
}

describe('axis library (schemaVersion 2)', () => {
  it('round-trips a non-empty axis library and libId-stamped map axes deep-equal', () => {
    const json = serializeProject(libraryProject());
    expect(json).toContain('"schemaVersion": 3');
    expect(json).toContain('"axisLibrary"');
    const r = parseProject(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(libraryProject());
  });

  it('omits axisLibrary when absent or empty', () => {
    expect(serializeProject(sampleProject())).not.toContain('axisLibrary');
    expect(serializeProject({ ...sampleProject(), axisLibrary: [] })).not.toContain('axisLibrary');
    const r = parseProject(serializeProject(sampleProject()));
    expect(r.ok && r.value.axisLibrary === undefined).toBe(true);
  });

  it('accepts a v1 document and normalizes it to the current schemaVersion', () => {
    const v1 = serializeProject(sampleProject()).replace('"schemaVersion": 3', '"schemaVersion": 1');
    const r = parseProject(v1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schemaVersion).toBe(3);
      expect(r.value.axisLibrary).toBeUndefined();
    }
  });

  it('rejects duplicate entry ids with an actionable message', () => {
    const p = libraryProject();
    p.axisLibrary = [p.axisLibrary![0]!, { ...p.axisLibrary![1]!, id: 'lib-rpm' }];
    const r = parseProject(serializeProject(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate entry id');
  });

  it('rejects entries that fail core validation, naming the culprit', () => {
    const p = libraryProject();
    p.axisLibrary = [{
      id: 'e1', name: 'TooFar',
      axis: { kind: 'referenced', address: 0xfff, count: 8, format: { width: 2, signed: false, endianness: 'big' } },
    }];
    const r = parseProject(serializeProject(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('TooFar');
    const q = libraryProject();
    q.axisLibrary = [{ id: 'e2', name: 'Idx', axis: { kind: 'index', count: 4 } }];
    expect(parseProject(serializeProject(q)).ok).toBe(false);
  });

  it('rejects malformed entry shapes with an actionable message', () => {
    const doc = JSON.parse(serializeProject(libraryProject())) as Record<string, unknown>;
    const cases: Array<[unknown, string]> = [
      ['nope', 'axisLibrary must be an array'],
      [[42], 'entry must be an object'],
      [[{ id: 7, name: 'x', axis: { kind: 'literal', count: 1, values: [0] } }], 'entry id must be a string'],
      [[{ id: 'e', name: 8, axis: { kind: 'literal', count: 1, values: [0] } }], 'entry name must be a string'],
      [[{ id: 'e', name: 'x', notes: 9, axis: { kind: 'literal', count: 1, values: [0] } }], 'entry notes must be a string'],
      [[{ id: 'e', name: 'x', axis: { kind: 'bogus', count: 1 } }], 'axis has invalid kind'],
    ];
    for (const [lib, msg] of cases) {
      const r = parseProject(JSON.stringify({ ...doc, axisLibrary: lib }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(msg);
    }
  });

  it('rejects a non-string libId on a map axis (shape gate)', () => {
    const doc = JSON.parse(serializeProject(libraryProject())) as { maps: Array<{ xAxis: Record<string, unknown> }> };
    doc.maps[0]!.xAxis['libId'] = 5;
    const r = parseProject(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('libId must be a string');
  });

  it('tolerates a dangling libId on a map axis (cleared app-side on load, never rejected here)', () => {
    const { axisLibrary: _lib, ...rest } = libraryProject();
    const dangling: Project = { ...rest };
    const r = parseProject(serializeProject(dangling));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maps[0]!.xAxis!.libId).toBe('lib-rpm');
  });
});

describe('project lineage (schemaVersion 3)', () => {
  const OTHER = '1'.repeat(64);

  it('round-trips derivedFrom', () => {
    const p: Project = { ...sampleProject(), derivedFrom: { name: 'stock.bin', sha256: OTHER } };
    const r = parseProject(serializeProject(p));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.derivedFrom).toEqual({ name: 'stock.bin', sha256: OTHER });
  });

  it('omits derivedFrom entirely when absent', () => {
    expect(serializeProject(sampleProject())).not.toContain('derivedFrom');
  });

  it('writes schemaVersion 3', () => {
    expect(serializeProject(sampleProject())).toContain('"schemaVersion": 3');
  });

  it('is byte-stable with lineage — serializing a parsed project reproduces the text', () => {
    const once = serializeProject({ ...sampleProject(), derivedFrom: { name: 'stock.bin', sha256: OTHER } });
    const r = parseProject(once);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializeProject(r.value)).toBe(once);
  });

  it('accepts a v2 document, normalizing to 3 with no lineage', () => {
    const v2 = serializeProject(sampleProject()).replace('"schemaVersion": 3', '"schemaVersion": 2');
    const r = parseProject(v2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schemaVersion).toBe(3);
      expect(r.value.derivedFrom).toBeUndefined();
    }
  });

  it('rejects a bad derivedFrom sha rather than carrying a lie', () => {
    const bad = serializeProject({
      ...sampleProject(),
      derivedFrom: { name: 'stock.bin', sha256: OTHER },
    }).replace(OTHER, 'nope');
    const r = parseProject(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('derivedFrom');
  });

  it('rejects a derivedFrom with no name', () => {
    const doc = JSON.parse(serializeProject(sampleProject())) as Record<string, unknown>;
    doc['derivedFrom'] = { sha256: OTHER };
    const r = parseProject(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('derivedFrom');
  });
});
