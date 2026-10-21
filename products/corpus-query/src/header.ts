export interface ParsedHeader {
  fields: Record<string, string>;
  /** Character index where the body begins, past the header block and its blank line. */
  bodyStart: number;
}

const HEADER_LINE = /^([A-Z][A-Z_]*):[ \t]*(.*?)\r?$/;

/** Reads a leading block of `KEY: value` lines. A file that does not open with one has an empty header. */
export function parseHeader(text: string): ParsedHeader {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < text.length) {
    const eol = text.indexOf("\n", pos);
    const end = eol === -1 ? text.length : eol;
    const match = HEADER_LINE.exec(text.slice(pos, end));
    if (!match) break;
    fields[match[1]!] = match[2]!;
    pos = eol === -1 ? text.length : eol + 1;
  }
  if (Object.keys(fields).length === 0) return { fields, bodyStart: 0 };
  return { fields, bodyStart: pos };
}

/** `TITLE: PM 6.8 - Some Title` splits at the first ` - `; a title with no code is all title. */
export function splitTitle(raw: string): { code: string | undefined; title: string } {
  const at = raw.indexOf(" - ");
  if (at === -1) return { code: undefined, title: raw.trim() };
  return { code: raw.slice(0, at).trim(), title: raw.slice(at + 3).trim() };
}
