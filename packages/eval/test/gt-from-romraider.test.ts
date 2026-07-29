import { mkdtempSync, readFileSync as readF, writeFileSync as writeF } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import { buildGroundTruth, fo } from '../src/gt-from-romraider.js';
import { runGtFromRomraider } from '../src/cli.js';

describe('fo (MS41 flash-bus descramble)', () => {
  it('matches the byte-verified vectors from the ms41-cal-defs reference', () => {
    expect(fo(0x48c)).toBe(0x1448c);
    expect(fo(0x4763)).toBe(0x10763);
    expect(fo(0x0)).toBe(0x14000);
    expect(fo(0x3fff)).toBe(0x17fff);
    expect(fo(0x4000)).toBe(0x10000);
    expect(fo(0x5fff)).toBe(0x11fff);
  });
});

/** Mini def: two eligible 3D tables (one an alias, one dead), a 1×N curve, an axis-less 3D. */
const DEF = `<roms>
<rom>
  <romid><xmlid>GT1</xmlid></romid>
  <table type="3D" name="A" storagetype="uint8" sizex="4" sizey="4" storageaddress="0x10">
    <scaling units="ms" expression="x*0.0053" to_byte="x/0.0053" format="0.00"/>
    <table type="X Axis" name="RPM" storagetype="uint8" storageaddress="0x0"/>
    <table type="Y Axis" name="Load" storagetype="uint8" storageaddress="0x8"/>
  </table>
  <table type="3D" name="A alias" storagetype="uint8" sizex="4" sizey="4" storageaddress="0x10">
    <table type="X Axis" storagetype="uint8" storageaddress="0x0"/>
    <table type="Y Axis" storagetype="uint8" storageaddress="0x8"/>
  </table>
  <table type="3D" name="Dead" storagetype="uint8" sizex="2" sizey="2" storageaddress="0x100">
    <table type="X Axis" storagetype="uint8" storageaddress="0x0"/>
    <table type="Y Axis" storagetype="uint8" storageaddress="0x8"/>
  </table>
  <table type="2D" name="Curve" storagetype="uint8" sizex="8" storageaddress="0x40"/>
  <table type="3D" name="NoAxes" storagetype="uint8" sizex="2" sizey="2" storageaddress="0x60"/>
</rom>
</roms>`;

function testBin(): ReturnType<typeof createBinImage> {
  const bytes = new Uint8Array(0x200);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251; // non-uniform everywhere…
  for (let i = 0x100; i < 0x104; i++) bytes[i] = 0xff; // …except the dead table
  return createBinImage(bytes, 'test.bin');
}

describe('buildGroundTruth', () => {
  it('filters to two-axis 2D+ tables, dedupes aliases, skips dead tables, sorts and re-ids', () => {
    const r = buildGroundTruth(DEF, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { truth, warnings } = r.value;
    expect(truth.fixture).toBe('fx');
    expect(truth.binSha256).toBe(testBin().sha256);
    expect(truth.maps).toHaveLength(1);
    expect(truth.maps[0]).toMatchObject({
      id: 'p-0x10', name: 'A', address: 0x10, rows: 4, cols: 4, provenance: 'imported',
    });
    expect(truth.maps[0]!.xAxis).toMatchObject({ kind: 'referenced', address: 0x0, count: 4 });
    expect(warnings.some((w) => w.includes('alias'))).toBe(true);
    expect(warnings.some((w) => w.includes('dead table'))).toBe(true);
  });

  it('applies fo() to table and axis addresses and keeps the ORIGINAL sa in the id', () => {
    const bytes = new Uint8Array(0x18000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const bin = createBinImage(bytes, 'full.bin');
    const r = buildGroundTruth(DEF, bin, { fixture: 'fx', idPrefix: 'p', applyFo: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value.truth.maps[0]!;
    expect(m.id).toBe('p-0x10');
    expect(m.address).toBe(fo(0x10));
    expect(m.xAxis!.address).toBe(fo(0x0));
    expect(m.yAxis!.address).toBe(fo(0x8));
  });

  it('errors (not warns) when a kept map fails validateMapDef, hinting at --fo', () => {
    const r = buildGroundTruth(DEF, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: true }); // 0x200 bin can't hold fo() addresses
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--fo');
  });

  it('skips out-of-window storageaddresses under --fo with a warning; the alias survives in its place', () => {
    // String.replace hits only the FIRST occurrence — table "A" moves to
    // 0x7000, "A alias" stays at 0x10 and becomes the survivor. "Dead"
    // (0x100) is NOT uniform-fill under this bin's byte pattern, so it
    // legitimately survives here too.
    const def = DEF.replace('storageaddress="0x10"', 'storageaddress="0x7000"');
    const bytes = new Uint8Array(0x18000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 3) % 253;
    const r = buildGroundTruth(def, createBinImage(bytes, 'b.bin'), { fixture: 'fx', idPrefix: 'p', applyFo: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truth.maps.map((m) => m.name)).toEqual(['A alias', 'Dead']);
    expect(r.value.truth.maps[0]!.address).toBe(fo(0x10));
    expect(r.value.warnings.some((w) => w.includes('outside the 24KB CAL window'))).toBe(true);
  });

  it('errors when no eligible truth maps remain', () => {
    const solo = `<roms><rom><romid><xmlid>GT1</xmlid></romid>
      <table type="3D" name="A" storagetype="uint8" sizex="4" sizey="4" storageaddress="0x7000">
        <table type="X Axis" storagetype="uint8" storageaddress="0x0"/>
        <table type="Y Axis" storagetype="uint8" storageaddress="0x8"/>
      </table>
    </rom></roms>`;
    const bytes = new Uint8Array(0x18000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 3) % 253;
    const r = buildGroundTruth(solo, createBinImage(bytes, 'b.bin'), { fixture: 'fx', idPrefix: 'p', applyFo: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no eligible truth maps');
  });

  it('passes romId through to the importer for multi-rom defs', () => {
    const multi = `<roms><rom><romid><xmlid>OTHER</xmlid></romid></rom>${DEF.slice('<roms>'.length)}`;
    const r = buildGroundTruth(multi, testBin(), { romId: 'GT1', fixture: 'fx', idPrefix: 'p', applyFo: false });
    expect(r.ok).toBe(true);
  });
});

/**
 * Mini def for curve mode (spec Phase 1 1D-curve detection): a 3D "Grid"
 * table (whose X/Y axes are cited addresses), (a) a real N×1 curve with a
 * referenced Y axis, (b) a shared-axis pseudo-curve whose storageaddress IS
 * Grid's X axis address (must be excluded — it's an axis, not a curve), and
 * (c) a second curve-shaped entry at (a)'s address (must dedupe to one).
 */
const CURVE_DEF = `<roms>
<rom>
  <romid><xmlid>GT1</xmlid></romid>
  <table type="3D" name="Grid" storagetype="uint8" sizex="4" sizey="4" storageaddress="0x10">
    <table type="X Axis" name="RPM" storagetype="uint8" storageaddress="0x0"/>
    <table type="Y Axis" name="Load" storagetype="uint8" storageaddress="0x8"/>
  </table>
  <table type="2D" name="RealCurve" storagetype="uint8" sizey="6" storageaddress="0x40">
    <table type="Y Axis" name="AxisA" storagetype="uint8" storageaddress="0x50"/>
  </table>
  <table type="2D" name="PseudoCurve" storagetype="uint8" sizex="4" storageaddress="0x0">
    <table type="X Axis" name="AxisB" storagetype="uint8" storageaddress="0x60"/>
  </table>
  <table type="2D" name="RealCurveAlias" storagetype="uint8" sizey="6" storageaddress="0x40">
    <table type="Y Axis" name="AxisA2" storagetype="uint8" storageaddress="0x50"/>
  </table>
</rom>
</roms>`;

describe('buildGroundTruth (class: curve)', () => {
  it('keeps the real curve, excludes the shared-axis pseudo-curve, and dedupes the aliased curve address', () => {
    const r = buildGroundTruth(CURVE_DEF, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false, class: 'curve' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { truth, warnings } = r.value;
    expect(truth.maps).toHaveLength(1);
    const m = truth.maps[0]!;
    expect(m).toMatchObject({ id: 'p-0x40', name: 'RealCurve', address: 0x40, rows: 6, cols: 1, provenance: 'imported' });
    expect(m.xAxis).toBeUndefined();
    expect(m.yAxis).toMatchObject({ kind: 'referenced', address: 0x50, count: 6 });
    expect(warnings.some((w) => w.includes('curve alias'))).toBe(true);
  });

  it('canonicalizes the sizex/X-Axis convention (1×N + xAxis) to N×1 + yAxis (PINNING: green pre-refactor)', () => {
    const def = `<roms><rom><romid><xmlid>GT1</xmlid></romid>
      <table type="2D" name="MirrorCurve" storagetype="uint8" sizex="6" storageaddress="0x40">
        <table type="X Axis" name="AxisM" storagetype="uint8" storageaddress="0x50"/>
      </table>
    </rom></roms>`;
    const r = buildGroundTruth(def, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false, class: 'curve' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truth.maps).toHaveLength(1);
    const m = r.value.truth.maps[0]!;
    expect(m).toMatchObject({ id: 'p-0x40', name: 'MirrorCurve', address: 0x40, rows: 6, cols: 1, provenance: 'imported' });
    expect(m.xAxis).toBeUndefined();
    expect(m.yAxis).toMatchObject({ kind: 'referenced', address: 0x50, count: 6 });
  });

  it('applies fo() to a curve address and its axis address, matching the 2D path', () => {
    const bytes = new Uint8Array(0x18000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const bin = createBinImage(bytes, 'full.bin');
    const r = buildGroundTruth(CURVE_DEF, bin, { fixture: 'fx', idPrefix: 'p', applyFo: true, class: 'curve' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value.truth.maps[0]!;
    expect(m.id).toBe('p-0x40');
    expect(m.address).toBe(fo(0x40));
    expect(m.yAxis!.address).toBe(fo(0x50));
  });

  it('keeps a curve whose declared referenced-axis count mismatches the curve length, with a warning (harness parity)', () => {
    // Real-def shape (0x6cc "ECT Sensor Scaling"): a 1×16 2D table declaring
    // a referenced Y AXIS — the importer assigns it count = rows = 1, so the
    // emitted 16×1 curve carries a count-1 yAxis. validateMapDef rejects
    // that, but the validated harness (and the pinned acceptance numbers)
    // INCLUDE such entries — the build must warn and keep, not fail.
    const def = `<roms><rom><romid><xmlid>GT1</xmlid></romid>
      <table type="2D" name="Degenerate" storagetype="uint8" sizex="16" storageaddress="0x40">
        <table type="Y Axis" name="Deg" storagetype="uint8" storageaddress="0x50"/>
      </table>
    </rom></roms>`;
    const r = buildGroundTruth(def, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false, class: 'curve' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truth.maps).toHaveLength(1);
    const m = r.value.truth.maps[0]!;
    expect(m).toMatchObject({ id: 'p-0x40', name: 'Degenerate', address: 0x40, rows: 16, cols: 1 });
    expect(m.yAxis).toMatchObject({ kind: 'referenced', address: 0x50, count: 1 }); // declared (mismatched) count preserved
    expect(r.value.warnings.some((w) => w.includes('p-0x40') && w.includes('Degenerate'))).toBe(true);
  });

  it('defaults to the 2D class when class is omitted (unchanged from before)', () => {
    const withDefault = buildGroundTruth(DEF, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false });
    const withExplicit2d = buildGroundTruth(DEF, testBin(), { fixture: 'fx', idPrefix: 'p', applyFo: false, class: '2d' });
    expect(withDefault).toEqual(withExplicit2d);
    expect(withDefault.ok).toBe(true);
    if (!withDefault.ok) return;
    expect(withDefault.value.truth.maps).toHaveLength(1);
    expect(withDefault.value.truth.maps[0]!.name).toBe('A');
  });
});

describe('runGtFromRomraider (CLI)', () => {
  it('reads files, writes <bin>.groundtruth.json and returns 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtfr-'));
    const defPath = join(dir, 'def.xml');
    const binPath = join(dir, 'test.bin');
    writeF(defPath, DEF);
    writeF(binPath, testBin().bytes);
    expect(runGtFromRomraider([defPath, binPath, '--fixture', 'fx', '--id-prefix', 'p'])).toBe(0);
    const truth = JSON.parse(readF(join(dir, 'test.groundtruth.json'), 'utf8'));
    expect(truth.maps).toHaveLength(1);
    expect(truth.binSha256).toBe(testBin().sha256);
  });

  it('returns 2 on missing arguments', () => {
    expect(runGtFromRomraider([])).toBe(2);
  });
});
