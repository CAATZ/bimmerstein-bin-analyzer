import { describe, expect, it } from 'vitest';
import {
  cpuToFile,
  foToSA,
  inCalWindow,
  MS41_BANK_XOR,
  MS41_CAL_SA_MAX,
  MS41_CAL_SA_MIN,
  MS41_MIN_BIN_LEN,
  saSpanContiguous,
  saToFo,
} from '../src/family/ms41/frame.js';

describe('MS41 frame law', () => {
  it('maps CPU to file: banks with bit 16 set have A14 inverted', () => {
    expect(cpuToFile(0x024670)).toBe(0x024670); // bank 2, direct (dispatcher body measured here)
    expect(cpuToFile(0x034ba6)).toBe(0x030ba6); // bank 3, XOR 0x4000 (cal-reader body measured here)
    expect(cpuToFile(0x034ab8)).toBe(0x030ab8);
    expect(cpuToFile(0x00c000)).toBe(0x00c000); // bank 0, direct
    expect(cpuToFile(0x014000)).toBe(0x010000); // bank 1, XOR 0x4000
  });

  it('maps cal SA to file offset (fo) and back', () => {
    expect(saToFo(0x0000)).toBe(0x14000);
    expect(saToFo(0x1fff)).toBe(0x15fff);
    expect(saToFo(0x2000)).toBe(0x16000);
    expect(saToFo(0x4000)).toBe(0x10000);
    expect(saToFo(0x5fff)).toBe(0x11fff);
    for (const sa of [0x0004, 0x2ad6, 0x35b8, 0x4048, 0x5fff]) expect(foToSA(saToFo(sa))).toBe(sa);
  });

  it('inCalWindow covers exactly the frame-mapped cal range', () => {
    expect(inCalWindow(0x0ffff)).toBe(false);
    expect(inCalWindow(0x10000)).toBe(true);
    expect(inCalWindow(0x11fff)).toBe(true);
    expect(inCalWindow(0x12000)).toBe(false);
    expect(inCalWindow(0x13fff)).toBe(false);
    expect(inCalWindow(0x14000)).toBe(true);
    expect(inCalWindow(0x17fff)).toBe(true);
    expect(inCalWindow(0x18000)).toBe(false);
  });

  it('exports the structural bounds', () => {
    expect(MS41_CAL_SA_MIN).toBe(4);
    expect(MS41_CAL_SA_MAX).toBe(0x5fff);
    expect(MS41_MIN_BIN_LEN).toBe(0x18000);
    expect(MS41_BANK_XOR).toBe(0x4000);
  });

  it('saSpanContiguous rejects runs crossing the SA 0x4000 seam or leaving cal', () => {
    expect(saSpanContiguous(0x0100, 0x100)).toBe(true); // fully below the seam
    expect(saSpanContiguous(0x3ff0, 0x10)).toBe(true); // ends exactly AT the seam
    expect(saSpanContiguous(0x3ff0, 0x11)).toBe(false); // crosses SA 0x4000 (fo 0x17fff → 0x10000)
    expect(saSpanContiguous(0x4000, 0x2000)).toBe(true); // fills the upper block exactly
    expect(saSpanContiguous(0x5ff0, 0x11)).toBe(false); // runs past the end of cal
  });
});
