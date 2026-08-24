import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const sources = (): { path: string; text: string }[] =>
  walk(join(import.meta.dirname, '..', 'src')).map((p) => ({
    path: p.replace(/\\/g, '/'),
    text: readFileSync(p, 'utf8'),
  }));

const hits = (re: RegExp): string[] =>
  sources()
    .filter((f) => re.test(f.text))
    .map((f) => f.path.slice(f.path.indexOf('src/')))
    .sort();

describe('the original buffer is reachable only where it should be', () => {
  it('originalBytes is named only by the type and the two construction sites', () => {
    expect(hits(/\boriginalBytes\b/)).toEqual([
      'src/live-session.ts',
      'src/session.ts',
      'src/tools/open-bin.ts',
    ]);
  });

  it("bufferFor is called with a LITERAL 'original' only by detection", () => {
    // The load-bearing guard (Part C §3.2). Read tools pass a PARSED argument,
    // not a literal, so this stays precise: a new value-read tool cannot
    // quietly become a detection consumer, and scanning edited bytes would
    // break P4's "same bytes -> same map ids" premise.
    // Matches a CALL — `bufferFor(entry, 'original')`. The declaration in
    // session.ts is not a hit: its parameters carry type annotations, so
    // `\w+,` cannot match `entry: OpenBin,`.
    expect(hits(/bufferFor\(\s*\w+\s*,\s*'original'\s*\)/)).toEqual([
      'src/tools/list-detected-axes.ts',
      'src/tools/scan-bin.ts',
    ]);
  });

  it('diffPair is called only by the edit-diff tool', () => {
    // list_edits legitimately needs BOTH buffers, and is not detection. Giving
    // it a named accessor instead of widening the literal-'original' allowlist
    // is what keeps that guard meaning "detection only" - so this pins the new
    // door as tightly as the old one.
    expect(hits(/diffPair\(\s*\w+\s*\)/)).toEqual(['src/tools/list-edits.ts']);
  });
});
