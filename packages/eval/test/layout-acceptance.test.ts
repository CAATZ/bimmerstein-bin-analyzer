import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinImage } from '@binanalyzer/core';
import * as engine from '@binanalyzer/engine';
import { runAcceptance } from '../src/cli.js';
import { parseGroundTruth } from '../src/groundtruth.js';

const key = 'id59-0940cf88-full';
const source = new URL(`../../../fixtures/ms41/acceptance/${key}.groundtruth.json`, import.meta.url);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'layout-accept-'));
  roots.push(root);
  const dir = join(root, 'fixtures/ms41/acceptance');
  mkdirSync(dir, { recursive: true });
  const parsed = parseGroundTruth(readFileSync(source, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  const truth = parsed.value;
  const bytes = new Uint8Array(262144);
  truth.binSha256 = createBinImage(bytes, key).sha256;
  writeFileSync(join(dir, `${key}.bin`), bytes);
  writeFileSync(join(dir, `${key}.groundtruth.json`), JSON.stringify(truth));
  const result = { ...engine.scan(new Uint8Array(0), engine.DEFAULT_SCAN_CONFIG), potentialMaps: structuredClone(truth.maps) };
  const scan = vi.spyOn(engine, 'scan').mockReturnValue(result);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { root, dir, truth, result, scan, log };
}

it('runs the exact layout cases without a local definition', () => {
  const { root, scan, log } = fixture();
  expect(runAcceptance(root)).toBe(0);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat().join('\n')).toContain(`PASS ${key}`);
});

it.each(['address', 'width', 'axis'] as const)('fails acceptance for %s drift despite the same detection count', change => {
  const { root, result } = fixture();
  const map = result.potentialMaps[0]!;
  if (change === 'address') map.address -= 2;
  if (change === 'width') map.format.width = 1;
  if (change === 'axis') map.yAxis!.address! += 1;
  expect(runAcceptance(root)).toBe(1);
});

it.each(['hash', 'missing truth', 'invalid truth', 'empty truth'] as const)('fails a present fixture with %s instead of skipping it', problem => {
  const { root, dir, truth, scan } = fixture();
  const path = join(dir, `${key}.groundtruth.json`);
  if (problem === 'hash') writeFileSync(join(dir, `${key}.bin`), new Uint8Array([1]));
  if (problem === 'missing truth') rmSync(path);
  if (problem === 'invalid truth') writeFileSync(path, '{}');
  if (problem === 'empty truth') writeFileSync(path, JSON.stringify({ ...truth, maps: [] }));
  expect(runAcceptance(root)).toBe(1);
  expect(scan).not.toHaveBeenCalled();
});
