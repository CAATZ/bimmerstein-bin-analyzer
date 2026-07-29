import { describe, expect, it } from 'vitest';
import { snapSelection } from '../src/lib/snap.js';

const U8 = { width: 1, signed: false, endianness: 'little' } as const;

/**
 * A 12×8 planted u8 map surrounded by high-variance filler. The surface is
 * bilinear WITH a cross term — a perfectly linear surface is degenerate
 * (equally smooth at several column counts; measured: the engine frames
 * `40+r*9+c*3` as 6 columns). This exact fixture was run against the real
 * engine while authoring the plan: snap → {start: 300, end: 396, cols: 8}.
 */
function plantedScene(): { bytes: Uint8Array; mapStart: number } {
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 97 + ((i * i) % 251)) & 0xff; // noisy filler
  const mapStart = 300;
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 8; c++) bytes[mapStart + r * 8 + c] = (40 + r * 8 + c * 5 + ((r * c) >> 1)) & 0xff;
  }
  return { bytes, mapStart };
}

describe('snapSelection (spec §7 selection assist — engine stage-3 scoring)', () => {
  it('finds the exact 12×8 framing of a planted map from a sloppy selection', () => {
    const { bytes, mapStart } = plantedScene();
    // user drags a bit past both edges
    const snap = snapSelection(bytes, mapStart - 3, mapStart + 12 * 8 + 5, U8);
    // Measured against the real engine during plan authoring — exact match:
    expect(snap).toEqual({ start: mapStart, end: mapStart + 12 * 8, cols: 8 });
  });

  it('returns null for ranges too small to frame', () => {
    const { bytes } = plantedScene();
    expect(snapSelection(bytes, 0, 6, U8)).toBeNull();
  });

  it('returns null when the engine finds no table in pure noise', () => {
    // High-entropy filler only — stage 3 should reject everything.
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 197 + ((i * 31) % 253) * 89) & 0xff);
    const snap = snapSelection(bytes, 64, 320, U8);
    // Deterministic fixture, measured against the real engine while
    // authoring the plan: stage 3 emits nothing here → null.
    expect(snap).toBeNull();
  });

  it('is deterministic', () => {
    const { bytes, mapStart } = plantedScene();
    const a = snapSelection(bytes, mapStart - 3, mapStart + 101, U8);
    const b = snapSelection(bytes, mapStart - 3, mapStart + 101, U8);
    expect(a).toEqual(b);
  });
});
