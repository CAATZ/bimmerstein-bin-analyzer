import type { Result } from '@binanalyzer/core';
import { crc16, type ChecksumReport, type FamilyChecksums } from '@binanalyzer/families';

/**
 * Evaluate a drop-in family module (spec §2).
 *
 * The file's BODY returns the family, so the file IS the object — no globals,
 * no registration call, no module-system pretence. `new Function` works because
 * `tauri.conf.json` sets `"csp": null`; nothing here needs a capability.
 *
 * Deliberately unsandboxed. Users load trusted executable extensions through
 * the installed app. The shape check validates the returned interface; it
 * does not restrict what module code can execute.
 */
const MEMBERS = ['applies', 'identify', 'verify', 'correct'] as const;

/** What a module gets. `crc16` only: without it, every module reimplements it. */
const API = { crc16 };

export function loadFamilyModule(source: string): Result<FamilyChecksums> {
  let produced: unknown;
  try {
    const factory = new Function('bin', source) as (api: typeof API) => unknown;
    produced = factory(API);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (typeof produced !== 'object' || produced === null || Array.isArray(produced)) {
    return {
      ok: false,
      error:
        'the file did not return a family object — its body must `return { familyId, applies, identify, verify, correct }`',
    };
  }
  const m = produced as Partial<FamilyChecksums>;
  if (typeof m.familyId !== 'string' || m.familyId === '') {
    return { ok: false, error: 'familyId must be a non-empty string' };
  }
  for (const k of MEMBERS) {
    if (typeof m[k] !== 'function') return { ok: false, error: `${m.familyId}: ${k} must be a function` };
  }
  return { ok: true, value: m as FamilyChecksums };
}

/**
 * Wrap a module so a throw becomes "this family does not apply" rather than a
 * crash (spec §6). `verify()` runs inside the save path; a module exploding
 * there must not take the save down with it.
 *
 * Each member reports at most once: a module that throws on `applies` throws on
 * EVERY probe, and a toast per keystroke helps nobody.
 */
export function guarded(mod: FamilyChecksums, onError: (message: string) => void): FamilyChecksums {
  const reported = new Set<string>();
  const say = (member: string, e: unknown): void => {
    if (reported.has(member)) return;
    reported.add(member);
    onError(`${mod.familyId}: ${member}() threw — ${e instanceof Error ? e.message : String(e)}`);
  };
  const inert = (): ChecksumReport => ({
    familyId: mod.familyId,
    applies: false,
    blocks: [],
    valid: false,
    skipped: [],
    notes: [`${mod.familyId} threw while checking this image, so it was ignored.`],
  });

  return {
    familyId: mod.familyId,
    applies: (b) => {
      try {
        return mod.applies(b);
      } catch (e) {
        say('applies', e);
        return false;
      }
    },
    identify: (b) => {
      try {
        return mod.identify(b);
      } catch (e) {
        say('identify', e);
        return undefined;
      }
    },
    verify: (b) => {
      try {
        return mod.verify(b);
      } catch (e) {
        say('verify', e);
        return inert();
      }
    },
    correct: (b) => {
      try {
        return mod.correct(b);
      } catch (e) {
        say('correct', e);
        // The INPUT back, untouched: a module that failed mid-correction must
        // never hand the save path a half-written buffer.
        return { bytes: b, report: inert(), changed: [] };
      }
    },
  };
}
