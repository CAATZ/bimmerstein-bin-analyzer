import { CAL_MAGIC, crc16 } from '@binanalyzer/families';

/**
 * A 24 KB image the MS41 checksum module actually recognises, for tests that
 * need `checksumsFor` to return a module rather than undefined.
 *
 * Built from the package's public primitives rather than imported from
 * `packages/families/test/`, which is not an entry point this app may reach
 * across.
 *
 * NOTE — near-identical builders also live in
 * `packages/families/test/fixture.ts` (which additionally does the 256 KB
 * framing) and `apps/mcp/test/verify-checksums.test.ts`. Three copies is what
 * package boundaries cost here; keep them in step. They are not silently
 * divergent — tightening the activation gate failed all of them in one run.
 *
 * Layout, which the gate cares about: the magic marks `start` and its first two
 * bytes ARE entry 0's offset word (0x004E); each checksum is stored at its
 * entry's exclusive upper bound, outside its own coverage; the next entry
 * begins at store + 2; the walk ends on a 0xFFFF terminator. Four entries,
 * because the gate rejects a terminating walk shorter than that — a lone entry
 * is what a magic landing in erased flash produces.
 */
export function ms41TuneImage(): Uint8Array {
  const size = 24 * 1024;
  const d = new Uint8Array(size);
  for (let i = 0; i < size; i++) d[i] = (i * 7) % 251;
  const start = 0x1000;
  d.set(CAL_MAGIC, start);
  d[start + 0x0e] = 0x12; // init BE hi
  d[start + 0x0f] = 0x34; // init BE lo

  const stores = [0x4e, 0x80, 0xb0, 0xe0];
  for (let i = 1; i < stores.length; i++) {
    const at = start + stores[i - 1]! + 2;
    d[at] = stores[i]! & 0xff;
    d[at + 1] = (stores[i]! >>> 8) & 0xff;
  }
  const end = start + stores[stores.length - 1]! + 2;
  d[end] = 0xff;
  d[end + 1] = 0xff;

  let from = start;
  for (const s of stores) {
    const store = start + s;
    const calc = crc16(d.subarray(from, store), 0x1234);
    d[store] = calc & 0xff;
    d[store + 1] = (calc >>> 8) & 0xff;
    from = store + 2;
  }
  return d;
}
