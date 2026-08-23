import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samePath } from '../src/platform/host.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.svelte') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const sources = (): { path: string; text: string }[] =>
  walk(join(import.meta.dirname, '..', 'src')).map((p) => ({
    path: p.replace(/\\/g, '/'),
    text: readFileSync(p, 'utf8'),
  }));

describe('only one place can write a binary', () => {
  it("the fs plugin's writeFile is imported in exactly one file", () => {
    // B1's invariant was "nothing writes bytes to disk". B2 grants
    // fs:allow-write-file, so the invariant becomes: exactly one file can.
    const importers = sources()
      .filter((f) => /from '@tauri-apps\/plugin-fs'/.test(f.text) && /\bwriteFile\b/.test(f.text))
      .map((f) => f.path.slice(f.path.indexOf('src/')));
    expect(importers).toEqual(['src/platform/tauri.ts']);
  });

  it('host.writeBinary is CALLED from exactly one source file', () => {
    // Matches a CALL (`host.writeBinary(`), which is why neither the declaration
    // in host.ts nor the implementation in tauri.ts is a hit — both are property
    // syntax with no leading dot.
    const callers = sources()
      .filter((f) => /\.writeBinary\(/.test(f.text))
      .map((f) => f.path.slice(f.path.indexOf('src/')));
    expect(callers).toEqual(['src/platform/flows.ts']);
  });
});

describe('the bin never swaps without clearing undo', () => {
  it('bin.set( appears in exactly the places that are allowed to', () => {
    // SessionSnapshot excludes checksumReport, and actions.ts's activeChecksums
    // is module-level and unsnapshotted too. Both are safe ONLY because every
    // path that swaps the loaded image clears the undo stack. A save must never
    // become another site.
    const sites = sources()
      .filter((f) => /\bbin\.set\(/.test(f.text))
      .map((f) => f.path.slice(f.path.indexOf('src/')));
    expect(sites.sort()).toEqual(['src/store/actions.ts', 'src/store/session-snapshot.ts']);

    const actions = readFileSync(join(import.meta.dirname, '..', 'src', 'store', 'actions.ts'), 'utf8');
    // setBin, applyProject, resetStores — and each of them clears undo.
    expect(actions.match(/\bbin\.set\(/g)).toHaveLength(3);
    expect(actions.match(/\bclearUndo\(\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('samePath', () => {
  it('matches across separators and Windows case', () => {
    expect(samePath('C:\\bins\\a.bin', 'C:/bins/a.bin')).toBe(true);
    expect(samePath('C:\\Bins\\A.BIN', 'c:\\bins\\a.bin')).toBe(true);
    expect(samePath('/x/y/a.bin', '/x/y/a.bin')).toBe(true);
  });

  it('does not match different files', () => {
    expect(samePath('C:\\bins\\a.bin', 'C:\\bins\\b.bin')).toBe(false);
    expect(samePath('C:\\bins\\a.bin', 'C:\\bins\\sub\\a.bin')).toBe(false);
  });
});

describe('the co-pilot cannot reach the save path', () => {
  it('no save symbol appears anywhere under src/copilot/', () => {
    // B2's guards above prove exactly one file CAN write. This one proves the
    // agent's half of the app cannot reach it (Part C §7). Writing an image
    // that gets flashed to an ECU is the user's action alone.
    const offenders = sources()
      .filter((f) => f.path.includes('/src/copilot/'))
      .filter((f) => /\b(saveBinFlow|correctForSave|applySaveCorrection|writeBinary)\b/.test(f.text))
      .map((f) => f.path.slice(f.path.indexOf('src/')));
    expect(offenders).toEqual([]);
  });
});

describe('a map pack is not reachable from the co-pilot', () => {
  it('no pack symbol appears anywhere under src/copilot/', () => {
    // Part C froze the dispatcher's op set; a pack must not become an
    // agent-reachable write path (map-packs spec §5).
    const offenders = sources()
      .filter((f) => f.path.includes('/src/copilot/'))
      .filter((f) => /\b(applyPackRows|openPackFlow|exportPackFlow|pendingPack|classifyPack)\b/.test(f.text))
      .map((f) => f.path.slice(f.path.indexOf('src/')));
    expect(offenders).toEqual([]);
  });
});
