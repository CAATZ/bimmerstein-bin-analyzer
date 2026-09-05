import { expect, it } from 'vitest';
import { EXACT_GATES, meetsExactGate } from '../src/exact-gates.js';

it('rejects any loss in exact starts, layouts or axis pairs despite perfect overlap scores', () => {
  const key = 'ms41-s52-ss1v2';
  const pin = EXACT_GATES[key]!;
  expect(pin.exactStartRecall).toBe(1);
  expect(pin.exactLayoutRecall).toBe(67 / 68);
  expect(meetsExactGate(pin, key)).toBe(true);
  for (const metric of ['exactStartRecall', 'exactLayoutRecall', 'axisPairRecall'] as const) {
    expect(meetsExactGate({ ...pin, [metric]: pin[metric] - 0.01 }, key)).toBe(false);
    expect(meetsExactGate({ ...pin, [metric]: NaN }, key)).toBe(false);
  }
  for (const id of ['41', '60']) for (const frame of ['full', 'partial']) {
    expect(EXACT_GATES[`reference-ms41-id${id}-${frame}`]?.exactStartRecall).toBeGreaterThan(0.9);
  }
  expect(Object.keys(EXACT_GATES)).toHaveLength(42);
});
