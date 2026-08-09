import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { checksumReport } from '../src/store/stores.js';
import { setChecksumReport } from '../src/store/actions.js';

describe('checksum report store', () => {
  it('starts empty', () => {
    setChecksumReport(undefined);
    expect(get(checksumReport)).toBeUndefined();
  });

  it('holds a report once set', () => {
    setChecksumReport({
      familyId: 'ms41', applies: true, blocks: [], valid: true, skipped: [], notes: [],
    });
    expect(get(checksumReport)?.valid).toBe(true);
    setChecksumReport(undefined);
  });
});
