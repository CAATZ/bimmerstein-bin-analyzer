import type { MapDef } from '@binanalyzer/core';
import { reviewLayouts, type LayoutReviewResult } from '../lib/layoutreview.js';

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<{ bytes: Uint8Array; map: MapDef }>) => void) | null;
  postMessage(message: LayoutReviewResult): void;
};
ctx.onmessage = ({ data }) => {
  const { bytes, map } = data;
  try {
    ctx.postMessage({ candidates: reviewLayouts(bytes, map) });
  } catch (error) {
    ctx.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
