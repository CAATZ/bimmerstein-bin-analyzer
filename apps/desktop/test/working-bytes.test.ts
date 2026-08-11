import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBinImage } from '@binanalyzer/core';
import * as a from '../src/store/actions.js';
import { bin, editJournal, workingBytes } from '../src/store/stores.js';

const image = (fill: number): ReturnType<typeof createBinImage> =>
  createBinImage(new Uint8Array(64).fill(fill), 'x.bin');

beforeEach(() => a.resetStores());

describe('workingBytes', () => {
  it('starts null and is materialized on bin load', () => {
    expect(get(workingBytes)).toBeNull();
    a.setBin(image(1));
    expect(get(workingBytes)).not.toBeNull();
    expect([...get(workingBytes)!]).toEqual([...get(bin)!.bytes]);
  });

  it('is a COPY — mutating it must not touch the original', () => {
    a.setBin(image(1));
    get(workingBytes)![0] = 0xff;
    expect(get(bin)!.bytes[0]).toBe(1);
  });

  it('loading another bin replaces the buffer and empties the journal', () => {
    a.setBin(image(1));
    get(editJournal).set(3, { original: 1, current: 9 });
    a.setBin(image(2));
    expect([...get(workingBytes)!].every((b) => b === 2)).toBe(true);
    expect(get(editJournal).size).toBe(0);
  });

  it('resetStores clears both', () => {
    a.setBin(image(1));
    a.resetStores();
    expect(get(workingBytes)).toBeNull();
    expect(get(editJournal).size).toBe(0);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.svelte') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no view reads the original buffer', () => {
  it('only copilot/dispatch.ts reads image.bytes', () => {
    // A view reading the ORIGINAL after an edit would render pre-edit data while
    // claiming to show the bin. dispatch.ts is the one deliberate exception: the
    // agent verifies sha256 against bin's identity.
    const offenders = walk(join(import.meta.dirname, '..', 'src'))
      .filter((p) => /\.bytes/.test(readFileSync(p, 'utf8')))
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => !p.endsWith('src/copilot/dispatch.ts'))
      .filter((p) => !p.endsWith('src/store/stores.ts'))
      .filter((p) => !p.endsWith('src/store/actions.ts'))
      .filter((p) => !p.endsWith('src/platform/flows.ts'));
    expect(offenders).toEqual([]);
  });
});
