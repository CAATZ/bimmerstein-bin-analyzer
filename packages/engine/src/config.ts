/**
 * ALL detection heuristic constants live here — never as magic numbers in
 * stage code. Tuning a constant = editing this file + running `pnpm eval`
 * (spec §4 contracts). Values below are starting points, expected to be
 * tuned against eval results during Phase 2.
 */
import type { ValueFormat } from '@binanalyzer/core';

export interface ScanConfig {
  region: {
    windowBytes: number;
    stepBytes: number;
    /** Entropy (bits/byte) above which a window leans 'code'. */
    codeEntropyMin: number;
    /** Fraction of 0x00/0xFF above which a window is 'empty'. */
    emptyFillMin: number;
  };
  axis: {
    minCount: number;
    maxCount: number;
    /** Candidate cell formats tried when scanning for monotone axis runs. */
    candidateFormats: ValueFormat[];
    /** Divisor for normalizing run length into a 0..1 score (count / divisor, capped at 1). */
    scoreCountDivisor: number;
    /** Multiplier applied to the score of counter-like runs (every delta === 1). */
    counterPenaltyFactor: number;
  };
  table: {
    minCols: number;
    /**
     * Widest column count the generic stage-3 brute scan considers (spec §4.3),
     * and the dim-validation ceiling for the family/cluster passes. 64 was an
     * untested placeholder; measured max true table width across ALL fixtures is
     * 20 (real MS41 s52 SS1v2 20×20; e36m3 ≤ 16; synthetic ≤ 16). Column counts
     * > this only ever produced FALSE positives, and the start×cols×format×phase
     * sweep is ~cols^1.7, so a wide ceiling dominates runtime (probe: 33→64 was
     * ~62 % of e2e for 0 net truth). 32 keeps ≥ 12 cols of margin over the widest
     * true table, cuts a 256 KB MS41 scan ≈2.6× (docs/notes/ms41-perf-maxcols-spike.md),
     * and keeps loc/struct/axis + every gate margin identical (only wide-FP
     * detections drop; real-bin fpD unchanged, synth-pool fpD improves). Raise
     * (eval-decided) only for a family with genuinely wider tables.
     */
    maxCols: number;
    minRows: number;
    maxRows: number;
    /**
     * Candidate cell widths to try, in order. Stage code derives its format
     * list from THIS field (widths >1 byte are tried in both endiannesses).
     * Width-4/float tables are out of scope for Plan A — add 4 when needed.
     */
    widths: Array<1 | 2 | 4>;
    /**
     * Row-growth tolerance: a candidate block stops growing past a row
     * boundary once the mean absolute column-wise delta between consecutive
     * rows exceeds `colSmoothFactor * (blockRange + 1)`. Lower = stricter
     * (shorter, more conservative blocks); higher = more permissive growth.
     * Minimum-size seeds may instead establish a steady slope over three rows;
     * this same relative tolerance bounds the change between successive slopes.
     */
    colSmoothFactor: number;
    /**
     * Absolute quantization floor for the row-growth test: a candidate row
     * whose mean |Δ| vs the previous row is <= this floor is always accepted,
     * regardless of the relative colSmoothFactor test. Integer-quantized cal
     * data (knock counters, small correction maps) steps by ~1 count per row
     * while the block's range is still tiny, which the purely relative test
     * misreads as a discontinuity (measured: the entire MS41 knock cluster).
     * Measured stable 1–2; 0.5 is insufficient (steps are exactly 1).
     */
    growthAbsFloor: number;
    /** Range expansion that triggers an established-block boundary check. */
    growthRangeMultiplier: number;
    /** Emit table candidates with composite smoothness score ≥ this. */
    minTableScore: number;
    /** Fraction of cells differing from a left/upper neighbor needed for full
     *  smoothness weight. Sparse outliers receive less weight; 0 disables it. */
    minVariationFraction: number;
    /**
     * Pre-emission edge-boundary floor (stage-3, spec §4.3 feed reduction). A
     * candidate is emitted only if BOTH its top and bottom edge ratio — the mean
     * row-to-row |Δ| between its boundary row and the adjacent pseudo-row, over
     * the block's own colTv — is >= this. Interior misframes from the start+=1
     * sweep begin/end inside smooth data (ratio ≈ 1) and are dropped; true tables
     * begin/end at a data boundary (measured 3–225×, score.ts). A region boundary
     * counts as an edge (OOB pseudo-row = pass). Companion to the pool-TIER
     * membership gate `pool.edgeMin` (=16) but applied at EMISSION and much lower:
     * it only removes deep-interior junk, leaving the pool/anchor tiers untouched.
     * 0 disables the filter (pre-2026-07 behavior). Pinned to 2 (measured
     * recall-safe on the pool-active MS41 family + synthetics: keeps every
     * committed fixture's recall, improves fpD, HOLDOUT PASS;
     * docs/notes/ms41-perf-stage3-spike.md). Raising it cuts more feed but
     * regresses adjacency-family recall margins (dedup reshuffle) — never raise
     * past the eval frontier that keeps all gates + holdout with margin.
     */
    emissionEdgeMin: number;
  };
  associate: {
    /** Max byte distance between an axis run and table start for 'nearby' match. */
    maxAxisDistance: number;
    /** Multiplier applied to an axis's score when it ends exactly at its anchor (gap 0), capped at 1. */
    adjacencyBonus: number;
    /**
     * Max byte gap tolerated between the y-axis end and the table start (and
     * between the x-axis end and the y-axis start) when matching an EXACT
     * anchor chain. Derived (carved-window) anchors are always zero-gap.
     * Default 0: measured [x][y][data] layouts are byte-adjacent.
     */
    anchorMaxGap: number;
  };
  pool: {
    /**
     * Cell formats tried when scanning count-prefixed axis pools
     * ([n][n monotone cells]); the count prefix is read in the same width and
     * endianness as the cells, unsigned. Measured MS41: u8 and u16-LE cover
     * 64/64 truth axes; u16-BE included for BE-family ECUs.
     */
    prefixFormats: ValueFormat[];
    /**
     * Max byte distance from a pool axis's end to the table start when
     * binding (measured true distances: 37–2296, median ~705). Stable
     * 2048–3072; 1024 loses a third of the bindings.
     */
    window: number;
    /**
     * Max byte distance between the two pair members (x and y pool axes).
     * True pairs sit near each other (median 16 B apart); stable 32–128.
     */
    pairSpan: number;
    /**
     * Pool mode activates only when at least this many MAXIMAL prefixed axes
     * exist in the bin — the pool-layout family signature. Measured: real
     * MS41 296; adjacency-family synthetics ≤ 2; pool-family synthetics
     * 24–35. Below the threshold stage 5 behaves exactly as before.
     */
    activateMinCount: number;
    /**
     * Start-edge one-sided ratio gate for pool-tier membership: the mean |Δ|
     * between the candidate's first row and the pseudo-row immediately before
     * it must be >= edgeMin × the candidate's own row-to-row variation. True
     * tables begin at data boundaries; sub-blocks and phase-shifted misframes
     * begin inside smooth data (ratio ≈ 1). Measured trade 8→32: higher favors
     * axis precision, lower favors location; 16 chosen. Generic-only scans
     * also admit a pair of boundaries whose row-trend prediction errors exceed
     * these same ratios relative to internal residual variation.
     */
    edgeMin: number;
    /**
     * Bottom end-edge one-sided ratio gate, companion to edgeMin (stage-3
     * addendum). A true table ENDS at a data boundary too: the mean |Δ| between
     * its last row and the pseudo-row immediately after it must be >= endEdgeMin
     * × the block's own row-to-row variation. Normal pool-tier membership
     * requires BOTH the top (edgeMin) and bottom (endEdgeMin) edge — a misframe
     * inside smooth data lacks a real bottom boundary. Measured peak at 16.
     */
    endEdgeMin: number;
    /**
     * Minimum raw residual used when measuring row-trend boundary evidence.
     * One raw step is the quantization floor: exact ramps must not produce an
     * unbounded boundary ratio. Generic-only pool scans use this value.
     */
    trendResidualFloor: number;
    /**
     * Adjacency-tight structural placement (pool tier). A tight axis packing
     * [rowAxis][colAxis][table] where the row-axis's last cell ends exactly at
     * the col-axis's count-prefix byte STRUCTURALLY defines a table at the
     * col-axis end (dims rowAxis.count × colAxis.count, axes = the pair) —
     * independent of byte-smoothness. This recovers dead/UNIFORM tables the
     * stage-3 smoothness scorer gates out (range 0 → score 0.1) and pins their
     * exact start, which a boundary-clipping byte misframe otherwise steals
     * (measured on real MS41 24KB cal partials). Emitted only when a candidate's
     * cell range is <= this (0 = uniform/dead tables only — the sole case
     * byte-smoothness cannot frame; non-uniform tables are left to the byte
     * scanner, so no real map is displaced). Inert off-pool (poolActive gate)
     * and on every committed + holdout fixture (byte-identical: the pattern
     * only occurs on real cal partials). Raising it past 0 lets the structural
     * tier override non-uniform byte detections — never do so without an eval
     * frontier that keeps all gates + holdout + parity digests.
     */
    structUniformMaxRange: number;
    /** Confidence assigned to adjacency-tight structural-placement detections. */
    structConfidence: number;
    /**
     * Partial-structural detector (spec §4.4, code-free MS4x path). Activation
     * floor: the header sweep must find at least this many valid backward
     * file-offset headers ([xPtr u16LE][yPtr u16LE] both pointing to
     * count-prefixed axis runs) for the detector to run at all. MEASURED
     * separation: every synthetic fixture and every scrambled 256KB full read
     * = 0; the two real direct-SA partials = 119 (e36m3) / 125 (s52). A floor of 32 sits in the
     * empty gap so the detector is inert on every committed + holdout fixture
     * (byte-identical) and active only on direct-framed cal partials.
     */
    structHeaderGateMin: number;
    /**
     * Axis count FLOOR used by the structural header decode + gate. 2 admits the
     * real 3-count stock axes (Class A: 0x17BE 8x3, 0x1AD8 3x8) which the strict
     * axis.minCount 4 rejects. Dedicated to the structural path — it does NOT
     * borrow family.ms41.headerAxisMinCount, so the pool tier has no dependency
     * on the family module.
     */
    structHeaderAxisMinCount: number;
    /**
     * Axis count CEILING used by the structural header decode + gate. Dedicated
     * (does NOT borrow axis.maxCount) so a change to the generic axis scanner
     * cannot silently move the gate margin — e.g. raising axis.maxCount toward
     * 255 turns 0xFF-fill regions of a full read into "valid dead axes" and would
     * open the gate on scrambled fulls. Task 3's gate-margin test pins that this
     * stays 0 on committed non-partials.
     */
    structAxisMaxCount: number;
    /**
     * Component C (packed tiling) smoothness floor. A candidate tile must score
     * at least this in the local frame-smoothness metric. Because the tiling is
     * already restricted to adjacency-tight chained plateau pairs (the stock
     * [axisChain][table] law), this is a SECONDARY floor in a measured-comfortable
     * band: the real SS1v2 customs score 0.859-0.951 and the observed spurious
     * runs score below ~0.70, so [0.70, 0.80] all cross both partial targets with
     * e36m3 held. 0.75 chosen as the midpoint. UNVALIDATED on a third MS41
     * partial — do not move without a third-partial holdout.
     */
    structTileFrameMin: number;
    /** Maximum bytes searched after a tight axis pair for a packed run. */
    structTileWindow: number;
    /**
     * Component C: a tile RUN must be at least this long to emit (a real custom
     * group is a run of >= 3 packed tables; an isolated spurious block is
     * rejected). Structural floor, independent of structTileFrameMin.
     */
    structTileMinRun: number;
    /**
     * Component C: a plateau axis's strictly-monotone prefix must be
     * >= min(count, this). Matches the measured SS1v2 custom-axis strict lengths
     * (6-16); 4 admits all real custom shared axes.
     */
    structTilePlateauStrictMin: number;
    /**
     * Partial 1D-curve discriminator (Phase 3, spike
     * docs/notes/ms41-p3-partial-curves-spike.md): count FLOOR for the 2-byte
     * backward-header axis decode. MEASURED at 2: count>=2 covers 64/64
     * (e36m3) and 64/71 (s52) partial curve GT as raw candidates (count>=4
     * loses 3-11 GT curves); the tiling discriminator carries precision, so
     * the loose floor costs nothing. Distinct from structHeaderAxisMinCount
     * (the 4-byte GRID header floor) — same reasoning, different sweep.
     */
    curvePartialMinCount: number;
    /**
     * Confidence assigned to partial 1D-curve detections (Phase 3). A
     * trusted-structure tiling pass is a WEAKER evidence class than the
     * full-read code-xref curve tiers — 0.5 (judgment at plan time, below
     * structConfidence 0.9) reflects the spike's measured junk upper bound
     * (~26% of passes vs an incomplete REAL set).
     */
    curvePartialConfidence: number;
    /**
     * P3.1-S1 HEADERLESS overlay (spike docs/notes/ms41-p31-headerless-spike.md):
     * count FLOOR for the trusted-axis q-sweep that generates headerless
     * fwd/rev strict-adjacency candidates. MEASURED at 2 (the pinned S1 rung;
     * both FlexFuel-trim recoveries also survive floors 4 and 6, with fewer
     * junk emissions). The tier-7 bridge sweep keeps curvePartialMinCount —
     * S1 shares the shipped feasible-sweep bridges, not this floor. The
     * parse-veto floor deliberately does NOT follow this knob (measured
     * inversion — see HEADLESS_PARSE_VETO_MIN_COUNT in partial-curves.ts).
     */
    curveHeadlessMinCount: number;
    /**
     * Confidence assigned to tier-8 headerless-curve detections. BELOW
     * curvePartialConfidence 0.5: the S1 extension's emission precision is
     * Q-B-measured at 25% (2 real / 8 emissions) — the weakest evidence
     * class in the pipeline, ranked below every other tier's claim.
     */
    curveHeadlessConfidence: number;
  };
  cluster: {
    /** Min |Δ| between adjacent bytes to count as a high-contrast separator step. */
    jumpMin: number;
    /** Min byte stride between consecutive separators in a cluster run. */
    strideMin: number;
    /** Max byte stride between consecutive separators in a cluster run. */
    strideMax: number;
    /** Min number of equally-spaced separators to treat as a packed cluster. */
    minReps: number;
    /** Tolerance (bytes) on the stride between consecutive separators. */
    strideTol: number;
    /** Max separator run length that may be taken directly as the sub-block column count. */
    sepLenMax: number;
    /** Min rows a sub-block must have to be emitted. */
    minSubRows: number;
    /**
     * Max column count tried when a separator's own width doesn't already
     * resolve the column count (companion to config.table.maxCols, but
     * bounded lower since cluster sub-blocks are narrow packed tables).
     */
    colSearchMax: number;
  };
  family: {
    /** MS41/C166 family analyzer (spec §4.6). Structural facts (ISA lengths, frame law, cal bounds) are vendored module constants, NOT here. */
    ms41: {
      /**
       * r12-freshness window: max instructions between a MOV r12,#data16 and
       * the CALLS that consumes it. Measured: 6 recovers 61/62 (e36m3) and
       * 67/68 (s52) truth starts; the sole miss (SA 0x2ad6) uses a
       * non-immediate path no window length reaches.
       */
      maxR12Dist: number;
      /**
       * Activation floor: min MOV r12,#cal-SA call sites in the whole image.
       * Measured: real MS41 721 (e36m3) / 769 (s52) sites; every synthetic fixture 0.
       */
      movImmCalMin: number;
      /** Reader self-location: min DISTINCT cal-SA args for a CALLS target to be scored. */
      readerMinArgs: number;
      /**
       * Reader self-location: min fraction of a target's args whose preceding
       * 4 bytes validate as an axis-pointer header. Measured separation on
       * both bins: true readers 67–100%, next-best target <= 2%.
       */
      readerHeaderRateMin: number;
      /** Max decoded instructions scanned into a callee body when classifying its fetch width. */
      widthScanMaxInstr: number;
      /**
       * Activation: min self-located readers. 2 hardens the gate against
       * sibling-C166 false activation (one accidental target clearing the
       * header-rate rule is conceivable; two independent ones are not).
       * Measured: both real bins select the same trio of 3; requiring 2
       * changes nothing on them.
       */
      minReaders: number;
      /**
       * Axis count floor for the per-start 4-byte HEADER decode (v2.1). Real
       * headers reference 3-count axes (measured Class A: 0x17BE 8×3,
       * 0x1AD8 3×8, 0x1B74 3×8 fail ONLY axis.minCount 4 on BOTH bins; exact
       * dims validate at 2). Applies ONLY here — reader self-location and the
       * generic pool scan keep the strict axis.minCount. Requires the
       * xPtr≠yPtr guard (the sole observed same-pointer phantom, s52 0x39BE,
       * appears exactly at minCount 2).
       */
      headerAxisMinCount: number;
      /**
       * Family-internal plateau axis scan (v2.1): count floor. The count
       * INCLUDES the plateau tail (measured law, e.g. 0x3636: count 20 =
       * 16 ascending u16 + 4× the last value). Feeds ONLY the family
       * fallback pool — never the generic pool.
       */
      plateauAxisMinCount: number;
      /**
       * Family plateau scan: the strictly-monotone prefix must be
       * >= min(count, this). Measured strict lengths on the SS1v2 custom
       * axes: 6–16; 4 finds all 5 custom shared axes + the FlexFuel x axis
       * with noise the fallback machinery absorbs (s52 330 hits, e36m3 288).
       */
      plateauStrictPrefixMin: number;
      /**
       * Relaxed-header SCAN tier (v2.1): axis count floor for the 4-byte
       * header sweep's pointer targets (plateau/dead cells tolerated —
       * measured: MAF 0x2AD6's axes are zero-filled). Stays at the strict
       * axis floor 4: only the r12-corroborated HEADER path may drop to
       * headerAxisMinCount 2.
       */
      scanAxisMinCount: number;
      /**
       * Curve-reader self-location: min DISTINCT cal-SA args for a CALLS
       * target to be scored (mirrors readerMinArgs). Measured: the curve-
       * reader quartet's header rate sits at 98–100% vs a 24–26% base rate
       * for unrelated CALLS targets, on both real MS41 full reads.
       */
      curveReaderMinArgs: number;
      /**
       * Curve-reader self-location: min fraction of a target's args whose
       * preceding 2 bytes validate as a backward axis-pointer header.
       * Measured: the curve-reader quartet's header rate sits at 98–100%
       * vs a 24–26% base rate for unrelated CALLS targets, on both real
       * MS41 full reads.
       */
      curveReaderHeaderRateMin: number;
      /**
       * Axis count floor applied when validating a curve reader's backward
       * 2-byte header pointer. Measured: the curve-reader quartet's header
       * rate sits at 98–100% vs a 24–26% base rate for unrelated CALLS
       * targets, on both real MS41 full reads.
       */
      curveAxisMinCount: number;
      /**
       * Activation floor for the curve tier: min curve-reader CALL SITES
       * (calls whose target is a self-located curve reader) before the tier
       * runs — the analog of movImmCalMin for synthetic inertness. Measured:
       * every synthetic fixture yields 0 curve-reader call sites; both real
       * MS41 full reads yield well over 100 (175+/185+ distinct curve args).
       */
      curveActivateMin: number;
      /**
       * Axis-count floor for FALLBACK curve emission (tier 5, and the
       * adjacency tier 6's axis validation). Deliberately SEPARATE from
       * curveAxisMinCount, which is shared with curve-reader SELF-LOCATION
       * (readers.ts): lowering that shared knob to 2 would put the non-trio
       * target 0x348ac (121 args, w2-classifiable) at 49.6% header rate vs
       * the 0.50 admission floor — a one-arg margin (measured, spike
       * 2026-07-15). Emission-only floor 2 recovers the count-2/3 curves
       * (all 3 former "stock misses" + s52 sensor scalings); the 2-byte
       * header stays position-locked (validity at sa±1/±3 is 0–1.6%).
       */
      curveEmitMinCount: number;
      /**
       * S* parameter census (Switch Phase B, spike docs/notes/
       * ms41-switch-detection-spike.md): forward test/consumer window in
       * INSTRUCTIONS after a direct-mem cal load. Measured: K 6/8/10 is
       * truth/VIRGIN-invariant (K=10 adds 1 detOnly); 8 is the pinned ladder
       * value.
       */
      paramTestWindow: number;
      /** Maximum decoded instructions per raw-value/control-flow trace. */
      consumerMaxInstructions: number;
      /** Maximum helper-call or RAM-publication links followed by a trace. */
      consumerMaxDepth: number;
      /**
       * V1d arg-pass rung: max instruction distance from a plain load to the
       * CALLS consuming it. Measured (S3 sensitivity): S* truth FLAT at
       * 2/3/4; 2 sheds 3 VIRGIN junk per bin at zero truth cost. NOTE: the
       * ladder script's pinned output ran at 3 — the =2 default is the
       * S3-measured tightening (plan Task 0 re-verified both).
       */
      paramCallsMax: number;
      /**
       * Defense-in-depth activation for the param tier: min self-located
       * grid readers. Both real bins locate the same trio of 3; the
       * synth-curve fixtures locate exactly 2. NOT the primary synthetic
       * protection — the pinned zero-emission fixture tests are (spike:
       * "do not rely on it alone").
       */
      paramMinReaders: number;
      /**
       * Confidence for code-referenced parameter emissions (1×1). BELOW
       * curveHeadlessConfidence 0.4 — the weakest-claim tier in the
       * pipeline (site-level evidence, no structure).
       */
      paramConfidence: number;
    };
  };
  score: {
    /** Weight applied to the table's smoothness score in the confidence composite. */
    wSmooth: number;
    /** Weight applied to the association stage's axisFit in the confidence composite. */
    wAxis: number;
    /** Weight applied to the dimension prior (dimPrior) in the confidence composite. */
    wDim: number;
    /** A lower-confidence candidate overlapping a kept one by more than this byte fraction is dropped. */
    overlapMax: number;
    /** Emit potential maps with composite confidence ≥ this. */
    minConfidence: number;
    /** rows/cols inclusive lower bound of the "ideal" dimension band (dimPrior weight dimPriorIdealWeight). */
    dimPriorIdealMin: number;
    /** rows/cols inclusive upper bound of the "ideal" dimension band. */
    dimPriorIdealMax: number;
    /** dimPrior weight when both rows and cols fall within [dimPriorIdealMin, dimPriorIdealMax]. */
    dimPriorIdealWeight: number;
    /** rows/cols inclusive lower bound of the "acceptable" dimension band (dimPrior weight dimPriorOkWeight). */
    dimPriorOkMin: number;
    /** rows/cols inclusive upper bound of the "acceptable" dimension band. */
    dimPriorOkMax: number;
    /** dimPrior weight when both rows and cols fall within [dimPriorOkMin, dimPriorOkMax] but outside the ideal band. */
    dimPriorOkWeight: number;
    /** dimPrior weight when neither the ideal nor acceptable band matches. */
    dimPriorFallbackWeight: number;
    /**
     * Shear gate for ANCHORED candidates (spec §4.3 "correct column count
     * minimizes vertical discontinuity"): widening the block by one column
     * must multiply its mean row-to-row variation by at least this factor to
     * qualify for the top rank tier. Measured on the synthetic fixtures:
     * true blocks 37–225×, spurious/misframed blocks ≈1×; results stable for
     * thresholds 10–30, degrading by 50. One-sided by design — as an argmax
     * this signal is hijacked by small slivers; only the gate form works.
     */
    shearGateMin: number;
  };
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  region: { windowBytes: 256, stepBytes: 64, codeEntropyMin: 6.5, emptyFillMin: 0.9 },
  axis: {
    minCount: 4,
    maxCount: 64,
    candidateFormats: [
      { width: 2, signed: false, endianness: 'big' },
      { width: 2, signed: false, endianness: 'little' },
      { width: 2, signed: true, endianness: 'big' },
      { width: 2, signed: true, endianness: 'little' },
      { width: 1, signed: false, endianness: 'big' },
      { width: 1, signed: true, endianness: 'big' },
    ],
    scoreCountDivisor: 16,
    counterPenaltyFactor: 0.3,
  },
  table: {
    minCols: 2,
    maxCols: 32,
    minRows: 2,
    maxRows: 128,
    widths: [2, 1],
    colSmoothFactor: 0.4,
    growthAbsFloor: 1,
    growthRangeMultiplier: 2,
    minTableScore: 0.5,
    minVariationFraction: 0.3,
    emissionEdgeMin: 2,
  },
  associate: { maxAxisDistance: 512, adjacencyBonus: 1.2, anchorMaxGap: 0 },
  pool: {
    prefixFormats: [
      { width: 1, signed: false, endianness: 'big' },
      { width: 2, signed: false, endianness: 'little' },
      { width: 2, signed: false, endianness: 'big' },
    ],
    window: 2560,
    pairSpan: 64,
    activateMinCount: 16,
    edgeMin: 16,
    endEdgeMin: 16,
    trendResidualFloor: 1,
    structUniformMaxRange: 0,
    structConfidence: 0.9,
    structHeaderGateMin: 32,
    structHeaderAxisMinCount: 2,
    structAxisMaxCount: 64,
    structTileFrameMin: 0.75,
    structTileWindow: 1024,
    structTileMinRun: 3,
    structTilePlateauStrictMin: 4,
    curvePartialMinCount: 2,
    curvePartialConfidence: 0.5,
    curveHeadlessMinCount: 2,
    curveHeadlessConfidence: 0.4,
  },
  cluster: { jumpMin: 40, strideMin: 16, strideMax: 512, minReps: 3, strideTol: 2, sepLenMax: 8, minSubRows: 3, colSearchMax: 16 },
  family: {
    ms41: {
      maxR12Dist: 6,
      movImmCalMin: 200,
      readerMinArgs: 5,
      readerHeaderRateMin: 0.5,
      widthScanMaxInstr: 40,
      minReaders: 2,
      headerAxisMinCount: 2,
      plateauAxisMinCount: 4,
      plateauStrictPrefixMin: 4,
      scanAxisMinCount: 4,
      curveReaderMinArgs: 5,
      curveReaderHeaderRateMin: 0.5,
      curveAxisMinCount: 4,
      curveActivateMin: 20,
      curveEmitMinCount: 2,
      paramTestWindow: 8,
      consumerMaxInstructions: 128,
      consumerMaxDepth: 2,
      paramCallsMax: 2,
      paramMinReaders: 3,
      paramConfidence: 0.3,
    },
  },
  score: {
    wSmooth: 0.5,
    wAxis: 0.3,
    wDim: 0.2,
    overlapMax: 0.25,
    minConfidence: 0.4,
    dimPriorIdealMin: 4,
    dimPriorIdealMax: 32,
    dimPriorIdealWeight: 1,
    dimPriorOkMin: 2,
    dimPriorOkMax: 64,
    dimPriorOkWeight: 0.6,
    dimPriorFallbackWeight: 0.3,
    shearGateMin: 20,
  },
};
