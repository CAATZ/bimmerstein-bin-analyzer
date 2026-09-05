import type { EvalScores } from './metrics.js';

type ExactScores = Pick<EvalScores, 'exactStartRecall' | 'exactLayoutRecall' | 'axisPairRecall'>;

// Measured regression floors. Improvements may raise these; never lower them.
export const EXACT_GATES: Record<string, ExactScores> = {
  'e36m3-curve': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.953125 },
  'e36m3-partial-2d': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.9838709677419355 },
  'e36m3-partial-curve': { exactStartRecall: 0.9375, exactLayoutRecall: 0.921875, axisPairRecall: 0.875 },
  'ms41-e36m3-stock': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.9838709677419355 },
  'ms41-s52-ss1v2': { exactStartRecall: 1, exactLayoutRecall: 0.9852941176470589, axisPairRecall: 0.9411764705882353 },
  'reference-ms41-id41-full': { exactStartRecall: 0.9661016949152542, exactLayoutRecall: 0.9661016949152542, axisPairRecall: 0.9152542372881356 },
  'reference-ms41-id41-partial': { exactStartRecall: 0.9322033898305084, exactLayoutRecall: 0.9152542372881356, axisPairRecall: 0.8813559322033898 },
  'reference-ms41-id60-full': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.9642857142857143 },
  'reference-ms41-id60-partial': { exactStartRecall: 1, exactLayoutRecall: 0.9642857142857143, axisPairRecall: 0.9285714285714286 },
  's52-curve': { exactStartRecall: 0.9577464788732394, exactLayoutRecall: 0.9577464788732394, axisPairRecall: 0.9014084507042254 },
  's52-partial-2d': { exactStartRecall: 1, exactLayoutRecall: 0.9852941176470589, axisPairRecall: 0.9558823529411765 },
  's52-partial-curve': { exactStartRecall: 0.8732394366197183, exactLayoutRecall: 0.8309859154929577, axisPairRecall: 0.7887323943661971 },
  'synth-1': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.75 },
  'synth-2': { exactStartRecall: 0.9, exactLayoutRecall: 0.9, axisPairRecall: 0.85 },
  'synth-3': { exactStartRecall: 0.9, exactLayoutRecall: 0.9, axisPairRecall: 0.7 },
  'synth-4': { exactStartRecall: 0.8571428571428571, exactLayoutRecall: 0.8571428571428571, axisPairRecall: 0.8571428571428571 },
  'synth-5': { exactStartRecall: 0.9444444444444444, exactLayoutRecall: 0.9444444444444444, axisPairRecall: 0.9444444444444444 },
  'synth-6': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 0.75 },
  'synth-7': { exactStartRecall: 0.9, exactLayoutRecall: 0.9, axisPairRecall: 0.75 },
  'synth-8': { exactStartRecall: 0.9166666666666666, exactLayoutRecall: 0.8333333333333334, axisPairRecall: 0.75 },
  'synth-curve-301': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-302': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-303': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-304': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-305': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-306': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-307': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-curve-308': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-partial-201': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-partial-202': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-partial-203': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-partial-204': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-pcurve-401': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-pcurve-402': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-pcurve-403': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-pcurve-404': { exactStartRecall: 1, exactLayoutRecall: 1, axisPairRecall: 1 },
  'synth-pool-101': { exactStartRecall: 0.15, exactLayoutRecall: 0.05, axisPairRecall: 0.05 },
  'synth-pool-102': { exactStartRecall: 0.1, exactLayoutRecall: 0.1, axisPairRecall: 0.1 },
  'synth-pool-103': { exactStartRecall: 0.13043478260869565, exactLayoutRecall: 0.043478260869565216, axisPairRecall: 0.043478260869565216 },
  'synth-pool-104': { exactStartRecall: 0.09090909090909091, exactLayoutRecall: 0.045454545454545456, axisPairRecall: 0.045454545454545456 },
  'synth-pool-105': { exactStartRecall: 0.13636363636363635, exactLayoutRecall: 0.13636363636363635, axisPairRecall: 0.13636363636363635 },
  'synth-pool-106': { exactStartRecall: 0.12, exactLayoutRecall: 0.04, axisPairRecall: 0.04 },
};

export function meetsExactGate(scores: ExactScores, fixture: string): boolean {
  const gate = EXACT_GATES[fixture];
  return gate === undefined || (scores.exactStartRecall >= gate.exactStartRecall &&
    scores.exactLayoutRecall >= gate.exactLayoutRecall && scores.axisPairRecall >= gate.axisPairRecall);
}
