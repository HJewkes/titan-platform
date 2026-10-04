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

const ECHO_OCTAL = /^0[0-7]{0,3}/;

/**
 * Decodes the body of a `$'...'` string the way bash does, so `$'\x7e'` reads as `~`.
 * The `echo` mode is for `echo -e` and `printf %b`: octal is `\0nnn` there, and `\c` ends the output.
 */
export function decodeAnsiC(body: string, mode: "ansi-c" | "echo" = "ansi-c"): string {
  let out = "";
  for (let i = 0; i < body.length; ) {
    if (body[i] !== "\\" || i + 1 >= body.length) {
      out += body[i++];
      continue;
    }
    const rest = body.slice(i + 1);
    if (mode === "echo" && rest[0] === "c") return out;
    const { text, width } = decodeEscape(rest, mode);
    out += text;
    i += 1 + width;
  }
  return out;
}

function decodeEscape(rest: string, mode: "ansi-c" | "echo"): { text: string; width: number } {
  const c = rest[0] ?? "";
  if (mode === "echo" && c >= "1" && c <= "7") return { text: `\\${c}`, width: 1 };
  const simple = SIMPLE[c];
  if (simple !== undefined) return { text: simple, width: 1 };
  if (c === "c" && rest.length > 1) return { text: String.fromCharCode(rest.charCodeAt(1) & 0x1f), width: 2 };
  const numeric = mode === "echo" ? [[ECHO_OCTAL, 8] as [RegExp, number], ...NUMERIC.slice(1)] : NUMERIC;
  for (const [re, radix] of numeric) {
    const match = re.exec(rest)?.[0];
    if (!match) continue;
    const code = parseInt(radix === 8 ? match : match.slice(1), radix);
    if (code > 0x10ffff) break;
    return { text: String.fromCodePoint(code), width: match.length };
  }
  return { text: `\\${c}`, width: 1 };
}
