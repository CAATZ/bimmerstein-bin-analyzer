import type { Result } from '@binanalyzer/core';

/**
 * Tolerant XML scanner for real-world definition files (spec §6). NOT a
 * validating parser: it survives UTF-8 BOMs, DOCTYPE internal subsets with
 * custom <!ENTITY> declarations, stray text inside elements, raw `&`/`<` in
 * text, mismatched close tags and truncated input. Pure: string in,
 * Result<XmlElement> out — never throws.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Element's own text content, entity-decoded, whitespace-collapsed/trimmed. */
  text: string;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BUILTIN_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string, entities: Record<string, string>): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(cp) || cp > 0x10ffff ? whole : String.fromCodePoint(cp);
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(cp) || cp > 0x10ffff ? whole : String.fromCodePoint(cp);
    }
    return BUILTIN_ENTITIES[body] ?? entities[body] ?? whole; // unknown entity: keep literal
  });
}

/** Scan for the tag-closing '>' skipping quoted attribute values. Returns its index or -1. */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

export function parseXml(text: string): Result<XmlElement> {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const entities: Record<string, string> = {};
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const addText = (raw: string) => {
    const t = decodeEntities(raw, entities).replace(/\s+/g, ' ').trim();
    if (t.length > 0) top().text += (top().text.length > 0 ? ' ' : '') + t;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      addText(src.slice(i));
      break;
    }
    if (lt > i) addText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) break;
      const cdata = src.slice(lt + 9, end).replace(/\s+/g, ' ').trim();
      if (cdata.length > 0) top().text += (top().text.length > 0 ? ' ' : '') + cdata;
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (or other declaration), possibly with an [internal subset].
      let j = lt + 2;
      let depth = 0;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth === 0) break;
      }
      for (const m of src.slice(lt, j + 1).matchAll(/<!ENTITY\s+(\w+)\s+"([^"]*)"/g)) {
        entities[m[1]!] = decodeEntities(m[2]!, entities);
      }
      i = j + 1;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) break;
      const name = src.slice(lt + 2, end).trim();
      // Tolerant close: pop to the nearest matching open element, else ignore.
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]!.name === name) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    const after = src[lt + 1];
    if (after === undefined || !/[A-Za-z_]/.test(after)) {
      addText('<'); // stray '<' in text — tolerate
      i = lt + 1;
      continue;
    }
    const end = findTagEnd(src, lt + 1);
    if (end === -1) break;
    let tag = src.slice(lt + 1, end);
    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1);
    const nameMatch = /^[\w:.-]+/.exec(tag);
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    const el: XmlElement = { name: nameMatch[0], attrs: {}, children: [], text: '' };
    for (const m of tag.slice(nameMatch[0].length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      el.attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '', entities);
    }
    top().children.push(el);
    if (!selfClosing) stack.push(el);
    i = end + 1;
  }
  const first = root.children[0];
  if (!first) return { ok: false, error: 'no XML element found' };
  return { ok: true, value: first };
}
