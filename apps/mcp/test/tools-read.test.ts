import { describe, expect, it } from 'vitest';
import { call, errorText, fakeDeps, payload } from './helpers.js';
import { openBinTool, readBytesTool, readMapTool } from '../src/tools/index.js';
import { EDITED_BYTES, LIVE_BYTES, LIVE_SHA, dirtyLink, liveBins } from './link-fakes.js';

// 0..63 so every decode is checkable by hand.
const RAMP = new Uint8Array(64).map((_v, i) => i);

async function opened(bytes = RAMP): Promise<{ deps: ReturnType<typeof fakeDeps>; binId: string }> {
  const deps = fakeDeps({ bins: { '/b/r.bin': bytes } });
  const { binId } = payload<{ binId: string }>(await call(openBinTool, { path: '/b/r.bin' }, deps));
  return { deps, binId };
}

const U8 = { width: 1, signed: false, endianness: 'little' } as const;

describe('read_map (ad-hoc)', () => {
  it('decodes a grid with identity scaling', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readMapTool, { binId, map: { address: 0, rows: 2, cols: 4, format: U8 } }, deps));
    expect(r['source']).toBe('adhoc');
    expect(r['kind']).toBe('grid');
    expect(r['cells']).toBe(8);
    expect(r['values']).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    expect(r).not.toHaveProperty('raw');
  });

  it('applies scaling for physical values and returns both on request', async () => {
    const { deps, binId } = await opened();
    const args = { binId, map: { address: 0, rows: 1, cols: 4, format: U8, scaling: { factor: 2, offset: 1, units: 'ms', digits: 2 } }, values: 'both' };
    const r = payload(await call(readMapTool, args, deps));
    expect(r['values']).toEqual([[1, 3, 5, 7]]);
    expect(r['raw']).toEqual([[0, 1, 2, 3]]);
    expect(r['kind']).toBe('curve');
  });

  it('honors 0x-hex addresses and col-major orientation', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readMapTool, { binId, map: { address: '0x10', rows: 2, cols: 2, format: U8, orientation: 'col-major' } }, deps));
    expect(r['address']).toBe(16);
    expect(r['values']).toEqual([[16, 18], [17, 19]]);
  });

  it('rejects an out-of-range ad-hoc definition with the app validator message', async () => {
    const { deps, binId } = await opened();
    expect(errorText(await call(readMapTool, { binId, map: { address: 60, rows: 2, cols: 4, format: U8 } }, deps))).toContain('exceeds bin size 64');
  });

  it('rejects a request above the cell cap before touching bytes', async () => {
    const { deps, binId } = await opened();
    const text = errorText(await call(readMapTool, { binId, map: { address: 0, rows: 100, cols: 100, format: U8 } }, deps));
    expect(text).toContain('10000');
    expect(text).toContain('4096');
  });

  it('requires exactly one of mapId / map', async () => {
    const { deps, binId } = await opened();
    expect(errorText(await call(readMapTool, { binId }, deps))).toContain('exactly one');
    expect(errorText(await call(readMapTool, { binId, mapId: 'x', map: { address: 0, rows: 1, cols: 1, format: U8 } }, deps))).toContain('exactly one');
  });

  it('requires an explicit format for an ad-hoc definition', async () => {
    const { deps, binId } = await opened();
    expect(errorText(await call(readMapTool, { binId, map: { address: 0, rows: 1, cols: 2 } }, deps))).toContain('format');
  });
});

describe('read_bytes', () => {
  it('returns hex rows with ascii by default', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readBytesTool, { binId, address: 0, length: 4, cols: 4 }, deps));
    expect(r['as']).toBe('hex');
    const rows = r['hex'] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['address']).toBe(0);
    expect(rows[0]?.['bytes']).toBe('00 01 02 03');
    expect(r).not.toHaveProperty('values');
  });

  it('decodes values with an explicit format', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readBytesTool, { binId, address: 0, length: 4, cols: 2, as: 'values', format: { width: 2, signed: false, endianness: 'big' } }, deps));
    expect(r['values']).toEqual([[0x0001, 0x0203]]);
  });

  it('drops a trailing partial cell and reports it', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readBytesTool, { binId, address: 0, length: 5, as: 'values', format: { width: 2, signed: false, endianness: 'big' } }, deps));
    expect(r['values']).toEqual([[0x0001, 0x0203]]);
    expect(r['bytesDropped']).toBe(1);
  });

  it('clamps a read that runs past EOF and errors when it starts past EOF', async () => {
    const { deps, binId } = await opened();
    const r = payload(await call(readBytesTool, { binId, address: 60, length: 32 }, deps));
    expect(r['clamped']).toBe(true);
    expect(r['length']).toBe(4);
    expect(errorText(await call(readBytesTool, { binId, address: 64, length: 1 }, deps))).toContain('past the end');
  });

  it('rejects a length above the cap', async () => {
    const { deps, binId } = await opened();
    expect(errorText(await call(readBytesTool, { binId, address: 0, length: 4097 }, deps))).toContain('between 1 and 4096');
  });
});

describe('value reads see the working buffer', () => {
  const dirty = (): ReturnType<typeof fakeDeps> => fakeDeps({ link: dirtyLink(), bins: liveBins() });
  const oneByte = { address: 0, rows: 1, cols: 1, format: { width: 1 } };

  it('read_map defaults to working and says so', async () => {
    const p = payload(await call(readMapTool, { binId: LIVE_SHA, map: oneByte, values: 'raw' }, dirty()));
    expect(p['buffer']).toBe('working');
    expect(p['changedBytes']).toBe(1);
    expect((p['values'] as number[][])[0]![0]).toBe(EDITED_BYTES[0]);
  });

  it('read_map buffer:"original" returns the file as opened', async () => {
    const p = payload(
      await call(readMapTool, { binId: LIVE_SHA, map: oneByte, values: 'raw', buffer: 'original' }, dirty())
    );
    expect(p['buffer']).toBe('original');
    expect((p['values'] as number[][])[0]![0]).toBe(LIVE_BYTES[0]);
  });

  it('read_bytes takes the same selector', async () => {
    const working = payload(await call(readBytesTool, { binId: LIVE_SHA, address: 0, length: 1 }, dirty()));
    const original = payload(
      await call(readBytesTool, { binId: LIVE_SHA, address: 0, length: 1, buffer: 'original' }, dirty())
    );
    expect(working['buffer']).toBe('working');
    expect(original['buffer']).toBe('original');
    // Byte 0 is the one the dirty fixture flips, so the hex differs.
    expect(working['hex']).not.toEqual(original['hex']);
  });
});
