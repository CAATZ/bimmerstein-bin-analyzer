/**
 * Affine scaling expressions (spec §3: physical = raw*factor + offset).
 * parseAffineExpression decides affinity SYMBOLICALLY: every AST node is
 * folded to f(x) = a*x + b or rejected. Grammar: + - * / unary± ( ) numbers
 * and the variable x/X. Anything else (functions, comparisons, x*x, /x) is
 * non-affine → callers keep the original string in Scaling.rawExpression.
 */

type Token = { kind: 'num'; value: number } | { kind: 'x' } | { kind: 'op'; op: string };
interface Affine {
  a: number;
  b: number;
}
interface State {
  tokens: Token[];
  pos: number;
}

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  const re = /((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([xX])|([+\-*/()])|(\S)/g;
  for (const m of expr.matchAll(re)) {
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number.parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: 'x' });
    else if (m[3] !== undefined) tokens.push({ kind: 'op', op: m[3] });
    else return null; // any other non-space character: not affine arithmetic
  }
  return tokens;
}

function peekOp(s: State, op: string): boolean {
  const t = s.tokens[s.pos];
  return t !== undefined && t.kind === 'op' && t.op === op;
}

function parseFactor(s: State): Affine | null {
  const t = s.tokens[s.pos];
  if (t === undefined) return null;
  if (t.kind === 'op' && (t.op === '-' || t.op === '+')) {
    s.pos++;
    const inner = parseFactor(s);
    if (inner === null) return null;
    return t.op === '-' ? { a: -inner.a, b: -inner.b } : inner;
  }
  if (t.kind === 'num') {
    s.pos++;
    return { a: 0, b: t.value };
  }
  if (t.kind === 'x') {
    s.pos++;
    return { a: 1, b: 0 };
  }
  if (t.kind === 'op' && t.op === '(') {
    s.pos++;
    const inner = parseSum(s);
    if (inner === null || !peekOp(s, ')')) return null;
    s.pos++;
    return inner;
  }
  return null;
}

function parseTerm(s: State): Affine | null {
  let left = parseFactor(s);
  if (left === null) return null;
  while (peekOp(s, '*') || peekOp(s, '/')) {
    const op = (s.tokens[s.pos]! as { kind: 'op'; op: string }).op;
    s.pos++;
    const right = parseFactor(s);
    if (right === null) return null;
    if (op === '*') {
      if (left.a !== 0 && right.a !== 0) return null; // x*x — degree 2
      left = { a: left.a * right.b + right.a * left.b, b: left.b * right.b };
    } else {
      if (right.a !== 0 || right.b === 0) return null; // /x or /0
      left = { a: left.a / right.b, b: left.b / right.b };
    }
  }
  return left;
}

function parseSum(s: State): Affine | null {
  let left = parseTerm(s);
  if (left === null) return null;
  while (peekOp(s, '+') || peekOp(s, '-')) {
    const op = (s.tokens[s.pos]! as { kind: 'op'; op: string }).op;
    s.pos++;
    const right = parseTerm(s);
    if (right === null) return null;
    left = op === '+' ? { a: left.a + right.a, b: left.b + right.b } : { a: left.a - right.a, b: left.b - right.b };
  }
  return left;
}

export function parseAffineExpression(expr: string): { factor: number; offset: number } | null {
  const tokens = tokenize(expr.trim());
  if (tokens === null || tokens.length === 0) return null;
  const state: State = { tokens, pos: 0 };
  const result = parseSum(state);
  if (result === null || state.pos !== tokens.length) return null;
  if (!Number.isFinite(result.a) || !Number.isFinite(result.b)) return null;
  return { factor: result.a, offset: result.b };
}

/** String(n) is JS's shortest round-trip decimal — deterministic and re-parseable. */
function num(n: number): string {
  return String(n);
}

export function renderAffineExpression(factor: number, offset: number, varName: string): string {
  const head = factor === 1 ? varName : factor === 0 ? '' : `${varName}*${num(factor)}`;
  if (offset === 0) return head === '' ? '0' : head;
  if (head === '') return num(offset);
  return offset > 0 ? `${head}+${num(offset)}` : `${head}-${num(-offset)}`;
}

export function renderInverseExpression(factor: number, offset: number, varName: string): string | null {
  if (factor === 0) return null;
  // Parenthesize the shifted term ONLY when it is subsequently divided:
  // (1, 12) → 'x-12'; (0.75, -48) → '(x+48)/0.75'; (0.0025, 0) → 'x/0.0025'.
  const shifted = offset === 0 ? varName : offset > 0 ? `${varName}-${num(offset)}` : `${varName}+${num(-offset)}`;
  if (factor === 1) return shifted;
  return offset === 0 ? `${shifted}/${num(factor)}` : `(${shifted})/${num(factor)}`;
}

/** RomRaider display pattern → decimal digits: count of #/0 after the last dot. */
export function digitsFromFormat(format: string | undefined): number {
  if (format === undefined) return 0;
  const dot = format.lastIndexOf('.');
  if (dot === -1) return 0;
  let n = 0;
  for (const ch of format.slice(dot + 1)) if (ch === '#' || ch === '0') n++;
  return n;
}

export function formatFromDigits(digits: number): string {
  const d = Math.max(0, Math.trunc(digits));
  return d === 0 ? '#' : `#.${'#'.repeat(d)}`;
}
