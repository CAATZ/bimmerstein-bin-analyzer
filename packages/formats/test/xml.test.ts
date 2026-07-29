import { describe, expect, it } from 'vitest';
import { parseXml, xmlEscape } from '../src/xml.js';

function parseOk(s: string) {
  const r = parseXml(s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('parseXml', () => {
  it('parses nesting, attributes, self-closing tags and text', () => {
    const root = parseOk(`<rom base="B"><table name="T" storageaddress="0xE7E"/><romid><xmlid>12</xmlid></romid></rom>`);
    expect(root.name).toBe('rom');
    expect(root.attrs['base']).toBe('B');
    expect(root.children.map((c) => c.name)).toEqual(['table', 'romid']);
    expect(root.children[0]!.attrs['storageaddress']).toBe('0xE7E');
    expect(root.children[1]!.children[0]!.text).toBe('12');
  });

  it('tolerates BOM, XML declaration, comments, and stray text after an open tag', () => {
    // The BOM is constructed with fromCharCode on purpose — an invisible
    // literal BOM character in source is a landmine for editors and reviewers.
    const bom = String.fromCharCode(0xfeff);
    const root = parseOk(bom + `<?xml version="1.0"?><!-- c1 --><roms><rom> BMWMS41BASE\n<!-- v0.45 A & B -->\n<romid/></rom></roms>`);
    expect(root.name).toBe('roms');
    expect(root.children[0]!.text).toBe('BMWMS41BASE');
    expect(root.children[0]!.children[0]!.name).toBe('romid');
  });

  it('decodes DOCTYPE-declared entities, built-ins and character references', () => {
    const root = parseOk(
      `<!DOCTYPE roms [\n<!ENTITY deg "&#176;" ><!-- &deg; -->\n]>\n<t a="&deg;C" b="&amp;&lt;&gt;&quot;">A&#x41;&deg;</t>`
    );
    expect(root.attrs['a']).toBe('°C');
    expect(root.attrs['b']).toBe('&<>"');
    expect(root.text).toBe('AA°');
  });

  it('keeps unknown entities and raw ampersands literal (tolerant)', () => {
    const root = parseOk(`<t>ID 41 & ID 60 &unknown; ok</t>`);
    expect(root.text).toBe('ID 41 & ID 60 &unknown; ok');
  });

  it('treats a < that does not open a tag as literal text', () => {
    const root = parseOk(`<t>a < b</t>`);
    expect(root.text).toBe('a < b');
  });

  it('is quote-aware: > inside a quoted attribute does not end the tag', () => {
    const root = parseOk(`<t expr="if(x>3,1,0)" name="n"/>`);
    expect(root.attrs['expr']).toBe('if(x>3,1,0)');
    expect(root.attrs['name']).toBe('n');
  });

  it('recovers from a mismatched close tag and from EOF inside an element', () => {
    const root = parseOk(`<a><b>x</wrong></b><c>`);
    expect(root.name).toBe('a');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(root.children[0]!.text).toBe('x');
  });

  it('parses CDATA as text', () => {
    expect(parseOk(`<t><![CDATA[1 < 2 & 3]]></t>`).text).toBe('1 < 2 & 3');
  });

  it('keeps out-of-range numeric character references literal instead of throwing', () => {
    const root = parseOk(`<t a="&#xFFFFFFFF;">A&#99999999;B</t>`);
    expect(root.attrs['a']).toBe('&#xFFFFFFFF;');
    expect(root.text).toBe('A&#99999999;B');
  });

  it('fails with a Result (not a throw) when there is no element', () => {
    const r = parseXml('   just text   ');
    expect(r.ok).toBe(false);
  });
});

describe('xmlEscape', () => {
  it('escapes the four emission-relevant characters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d&quot;e'f`);
  });
});
