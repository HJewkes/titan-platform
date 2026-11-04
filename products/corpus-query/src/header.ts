export interface ParsedHeader {
  fields: Record<string, string>;
  /** Character index where the body begins: just past the header block, at the blank line that ends it. */
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

/**
 * Reads a leading `---` fenced block of flat `key: value` lines (YAML front matter).
 * A file that does not open with a closed fence has empty fields and starts its body at 0.
 */
export function parseFrontMatter(text: string): ParsedHeader {
  const open = /^---\r?\n/.exec(text);
  if (!open) return { fields: {}, bodyStart: 0 };
  const fields: Record<string, string> = {};
  let pos = open[0].length;
  while (pos < text.length) {
    const eol = text.indexOf("\n", pos);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(pos, end).replace(/\r$/, "");
    pos = eol === -1 ? text.length : eol + 1;
    if (line === "---") return { fields, bodyStart: pos };
    const match = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (match) fields[match[1]!] = unquote(match[2]!.trim());
  }
  return { fields: {}, bodyStart: 0 };
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}
