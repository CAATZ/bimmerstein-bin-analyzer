import type { Result } from '@binanalyzer/core';

export type Args = Record<string, unknown>;

export function asArgs(raw: unknown): Args {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Args) : {};
}

export function reqString(a: Args, key: string): Result<string> {
  const v = a[key];
  if (typeof v !== 'string' || v.length === 0) {
    return { ok: false, error: `"${key}" is required and must be a non-empty string` };
  }
  return { ok: true, value: v };
}

export function optString(a: Args, key: string): Result<string | undefined> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: `"${key}" must be a string` };
  return { ok: true, value: v };
}

export function optBool(a: Args, key: string, dflt: boolean): Result<boolean> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: dflt };
  if (typeof v !== 'boolean') return { ok: false, error: `"${key}" must be a boolean` };
  return { ok: true, value: v };
}

export function optInt(a: Args, key: string, dflt: number, min: number, max: number): Result<number> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: dflt };
  if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, error: `"${key}" must be an integer` };
  if (v < min || v > max) return { ok: false, error: `"${key}" must be between ${min} and ${max} (got ${v})` };
  return { ok: true, value: v };
}

export function optNumber(a: Args, key: string, min: number, max: number): Result<number | undefined> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `"${key}" must be a number` };
  if (v < min || v > max) return { ok: false, error: `"${key}" must be between ${min} and ${max} (got ${v})` };
  return { ok: true, value: v };
}

export function optEnum<T extends string>(a: Args, key: string, allowed: readonly T[], dflt: T): Result<T> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: dflt };
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    return { ok: false, error: `"${key}" must be one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: v as T };
}

export function optOneOf<T extends string>(a: Args, key: string, allowed: readonly T[]): Result<T | undefined> {
  const v = a[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    return { ok: false, error: `"${key}" must be one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: v as T };
}

/** Addresses are FILE OFFSETS: a non-negative integer or a 0x-hex string. */
function coerceAddress(v: unknown, key: string): Result<number> {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return { ok: false, error: `"${key}" must be a non-negative integer` };
    return { ok: true, value: v };
  }
  if (typeof v === 'string') {
    const s = v.trim();
    const n = /^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s, 16) : /^[0-9]+$/.test(s) ? Number.parseInt(s, 10) : Number.NaN;
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: `"${key}" value ${JSON.stringify(v)} is not an address — use 4096 or "0x1000"` };
    }
    return { ok: true, value: n };
  }
  return { ok: false, error: `"${key}" must be a non-negative integer or a 0x-hex string` };
}

export function reqAddress(a: Args, key: string): Result<number> {
  if (a[key] === undefined) return { ok: false, error: `"${key}" is required` };
  return coerceAddress(a[key], key);
}

export function optAddress(a: Args, key: string): Result<number | undefined> {
  if (a[key] === undefined) return { ok: true, value: undefined };
  const r = coerceAddress(a[key], key);
  return r.ok ? { ok: true, value: r.value } : r;
}
