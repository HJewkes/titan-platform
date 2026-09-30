const SIMPLE: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

const NUMERIC: Array<[RegExp, number]> = [
  [/^[0-7]{1,3}/, 8],
  [/^x[0-9A-Fa-f]{1,2}/, 16],
  [/^u[0-9A-Fa-f]{1,4}/, 16],
  [/^U[0-9A-Fa-f]{1,8}/, 16],
];

/** Decodes the body of a `$'...'` string the way bash does, so `$'\x7e'` reads as `~`. */
export function decodeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; ) {
    if (body[i] !== "\\" || i + 1 >= body.length) {
      out += body[i++];
      continue;
    }
    const { text, width } = decodeEscape(body.slice(i + 1));
    out += text;
    i += 1 + width;
  }
  return out;
}

function decodeEscape(rest: string): { text: string; width: number } {
  const c = rest[0] ?? "";
  const simple = SIMPLE[c];
  if (simple !== undefined) return { text: simple, width: 1 };
  if (c === "c" && rest.length > 1) return { text: String.fromCharCode(rest.charCodeAt(1) & 0x1f), width: 2 };
  for (const [re, radix] of NUMERIC) {
    const match = re.exec(rest)?.[0];
    if (!match) continue;
    const code = parseInt(radix === 8 ? match : match.slice(1), radix);
    if (code > 0x10ffff) break;
    return { text: String.fromCodePoint(code), width: match.length };
  }
  return { text: `\\${c}`, width: 1 };
}
