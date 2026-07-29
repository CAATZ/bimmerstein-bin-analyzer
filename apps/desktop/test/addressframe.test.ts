import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import type { Project } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { addressFrame } from '../src/store/stores.js';

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i);

function project(over: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    bin: { name: 'dump.bin', sha256: 'a'.repeat(64), size: 64 },
    valueDefaults: { width: 1, signed: false, endianness: 'little' },
    maps: [],
    potentialMaps: [],
    ...over,
  };
}

beforeEach(() => a.resetStores());

describe('addressFrame lifecycle', () => {
  it('defaults to none and resets on resetStores and setBin', () => {
    expect(get(addressFrame)).toBe('none');
    addressFrame.set('ms41full');
    a.resetStores();
    expect(get(addressFrame)).toBe('none');
    addressFrame.set('ms41full');
    a.setBin(createBinImage(BYTES, 'other.bin'));
    expect(get(addressFrame)).toBe('none');
  });

  it('projectSnapshot includes the frame only when active', () => {
    a.setBin(createBinImage(BYTES, 'dump.bin'));
    const plain = a.projectSnapshot();
    expect(plain.ok && plain.value.addressFrame === undefined).toBe(true);
    addressFrame.set('ms41full');
    const framed = a.projectSnapshot();
    expect(framed.ok && framed.value.addressFrame === 'ms41full').toBe(true);
  });

  it('applyProject restores the frame (and clears it when absent)', () => {
    const image = createBinImage(BYTES, 'dump.bin');
    a.applyProject(image, project({ addressFrame: 'ms41full' }));
    expect(get(addressFrame)).toBe('ms41full');
    a.applyProject(image, project());
    expect(get(addressFrame)).toBe('none');
  });
});
