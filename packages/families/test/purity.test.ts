import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('packages/families stays PURE', () => {
  it('imports no filesystem module and evaluates no source', () => {
    // The drop-in design leans on this: the APP reads the file and evaluates
    // it, then hands over a plain object. This package may depend on core and
    // nothing else, and file I/O belongs to the apps — if it ever grew an fs
    // import, that boundary would be broken and the loader would have two
    // homes.
    const offenders = walk(join(import.meta.dirname, '..', 'src'))
      .filter((p) => /from 'node:fs'|require\('fs'\)|new Function\(/.test(readFileSync(p, 'utf8')))
      .map((p) => p.replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
