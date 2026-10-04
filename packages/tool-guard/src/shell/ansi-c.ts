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

const OCTAL: Record<EscapeMode, RegExp> = {
  "ansi-c": /^[0-7]{1,3}/,
  echo: /^0[0-7]{0,3}/,
  "printf-b": /^(?:0[0-7]{0,3}|[1-7][0-7]{0,2})/,
};

/** Quotes are kept literal outside `$'...'`: every shell's echo and printf %b prints the backslash too. */
const QUOTES = new Set(["'", '"', "?"]);

/**
 * `echo -e` reads octal as `\0nnn` only; `printf %b` also takes `\nnn`; `$'...'` takes `\nnn` alone.
 * Outside `$'...'`, `\c` ends the output.
 */
type EscapeMode = "ansi-c" | "echo" | "printf-b";

/** Decodes the body of a `$'...'` string the way bash does, so `$'\x7e'` reads as `~`. */
export function decodeAnsiC(body: string, mode: EscapeMode = "ansi-c"): string {
  return decodeEscapes(body, mode).text;
}

/** `stopped` is set when a `\c` cut the output short: printf drops everything after it, not just the rest of the argument. */
export function decodeEscapes(body: string, mode: EscapeMode): { text: string; stopped: boolean } {
  let out = "";
  for (let i = 0; i < body.length; ) {
    if (body[i] !== "\\" || i + 1 >= body.length) {
      out += body[i++];
      continue;
    }
    const rest = body.slice(i + 1);
    if (mode !== "ansi-c" && rest[0] === "c") return { text: out, stopped: true };
    const { text, width } = decodeEscape(rest, mode);
    out += text;
    i += 1 + width;
  }
  return { text: out, stopped: false };
}

function decodeEscape(rest: string, mode: EscapeMode): { text: string; width: number } {
  const c = rest[0] ?? "";
  if (mode !== "ansi-c" && QUOTES.has(c)) return { text: `\\${c}`, width: 1 };
  const simple = SIMPLE[c];
  if (simple !== undefined) return { text: simple, width: 1 };
  if (c === "c" && rest.length > 1) return { text: String.fromCharCode(rest.charCodeAt(1) & 0x1f), width: 2 };
  const numeric: Array<[RegExp, number]> = [[OCTAL[mode], 8], ...NUMERIC.slice(1)];
  for (const [re, radix] of numeric) {
    const match = re.exec(rest)?.[0];
    if (!match) continue;
    const code = parseInt(radix === 8 ? match : match.slice(1), radix);
    if (code > 0x10ffff) break;
    return { text: String.fromCodePoint(code), width: match.length };
  }
  return { text: `\\${c}`, width: 1 };
}
