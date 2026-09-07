import { expect, it } from 'vitest';
import { EXACT_GATES, meetsExactGate } from '../src/exact-gates.js';
import { gateFor, MS41_GATE } from '../src/cli.js';

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
  expect(Object.keys(EXACT_GATES)).toHaveLength(66);
});

it('pins all six complete ID41 catalog classes without changing the older subset gates', () => {
  const expected = {
    'full-grid': [1, 109 / 110, 108 / 110],
    'full-curve': [1, 136 / 140, 136 / 140],
    'full-param': [419 / 420, 408 / 420, 0],
    'partial-grid': [109 / 110, 107 / 110, 106 / 110],
    'partial-curve': [139 / 140, 130 / 140, 129 / 140],
    'partial-param': [0, 0, 0], // No program code is present in the partial.
  };
  for (const [suffix, values] of Object.entries(expected)) {
    expect(EXACT_GATES[`reference-ms41-id41-catalog-${suffix}`]).toEqual({
      exactStartRecall: values[0], exactLayoutRecall: values[1], axisPairRecall: values[2],
    });
  }
});

it('scores scalar classes using exact floors without requiring nonexistent axes', () => {
  const key = 'reference-ms41-id41-catalog-full-param';
  expect(gateFor(key)).toBeUndefined();
  expect(meetsExactGate({ exactStartRecall: 1, exactLayoutRecall: 0, axisPairRecall: 0 }, key)).toBe(false);
  expect(gateFor('reference-ms41-id41-full')).toBe(MS41_GATE);
  expect(gateFor('reference-ms41-id41-catalog-full-grid')).toBe(MS41_GATE);
});

it('protects all three expanded firmware references in full and partial frames', () => {
  for (const rom of ['ss1v2', 'id60', 'id12']) {
    for (const frame of ['full', 'partial']) {
      for (const shape of ['grid', 'curve', 'param']) {
        const key = `reference-ms41-${rom}-expanded-${frame}-${shape}`;
        const pin = EXACT_GATES[key];
        expect(pin, key).toBeDefined();
        expect(meetsExactGate({ exactStartRecall: NaN, exactLayoutRecall: 1, axisPairRecall: 1 }, key)).toBe(false);
        if (pin === undefined) continue;
        expect(meetsExactGate(pin, key)).toBe(true);
        if (shape === 'param' && frame === 'partial') {
          expect(pin).toEqual({ exactStartRecall: 0, exactLayoutRecall: 0, axisPairRecall: 0 });
        } else {
          expect(pin.exactStartRecall).toBeGreaterThan(0.8);
          expect(meetsExactGate({ ...pin, exactLayoutRecall: pin.exactLayoutRecall - 0.001 }, key)).toBe(false);
        }
      }
    }
  }
});
