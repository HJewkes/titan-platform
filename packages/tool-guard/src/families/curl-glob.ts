/**
 * curl's own URL globbing, after `src/tool_urlglob.c`: a quoted URL word reaches curl intact, so the
 * shell's brace expansion never sees it, and curl itself turns `{a,b}` and `[1-3]` into several URLs.
 */

/** One glob or literal run; `list` is called only once the whole product is known to fit the cap. */
interface Piece {
  count: number;
  list: () => string[];
}

interface Parsed {
  piece: Piece;
  end: number;
}

const IPV6_LITERAL = /^[\da-f:.]+(%[\w.~%-]+)?$/i;
const NUMBER_RANGE = /^(\d+)-[ \t]*(\d+)(?::(\d+))?$/;
const LETTER_RANGE = /^([A-Za-z])-(.)(?::(\d+))?$/;
const GLOB_ESCAPES = new Set(["{", "[", "}", "]"]);

/**
 * The URLs curl requests for `text` in its own order (the rightmost glob varies fastest), or null when curl
 * would refuse the glob or it yields more than `cap` URLs. Text with no glob syntax gives `[text]`.
 * The caller decides whether curl globs at all: under `-g`/`--globoff` the word is literal and this is not called.
 */
export function expandCurlGlob(text: string, cap = 64): string[] | null {
  const pieces = parseGlob(text, cap);
  if (!pieces) return null;
  return pieces.reduce<string[]>((urls, p) => {
    const items = p.list();
    return urls.flatMap((url) => items.map((item) => url + item));
  }, [""]);
}

/** Refuses as soon as the running product passes `cap`, so a long run of ranges is never listed. */
function parseGlob(text: string, cap: number): Piece[] | null {
  const pieces: Piece[] = [];
  let total = 1;
  let literal = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const skip = c === "[" ? literalBracketLength(text, i) : 0;
    if (skip > 0) {
      literal += text.slice(i, i + skip);
      i += skip;
    } else if (c === "{" || c === "[") {
      const parsed = c === "{" ? readSet(text, i + 1) : readRange(text, i + 1);
      total *= parsed?.piece.count ?? Infinity;
      if (!parsed || total > cap) return null;
      pieces.push(literalPiece(literal), parsed.piece);
      literal = "";
      i = parsed.end;
    } else if (c === "}" || c === "]") {
      return null;
    } else {
      const escaped = c === "\\" && GLOB_ESCAPES.has(text[i + 1] ?? "");
      literal += escaped ? text[i + 1] : c;
      i += escaped ? 2 : 1;
    }
  }
  pieces.push(literalPiece(literal));
  return pieces;
}

function literalPiece(text: string): Piece {
  return { count: 1, list: () => [text] };
}

/** `[]` and an IPv6 literal such as `[::1]` or `[fe80::1%25en0]` are text; a range holds at most one colon. */
function literalBracketLength(text: string, open: number): number {
  const close = text.indexOf("]", open);
  if (close < 0) return 0;
  const body = text.slice(open + 1, close);
  if (body === "") return 2;
  const host = body.split("%")[0] as string;
  const colons = host.split(":").length - 1;
  return colons >= 2 && IPV6_LITERAL.test(body) ? close - open + 1 : 0;
}

/** A `{a,b,…}` set after its `{`: no nesting, `\` escapes any character, empty items allowed but not `{}`. */
function readSet(text: string, start: number): Parsed | null {
  const items: string[] = [];
  let item = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "{" || c === "[" || c === "]") return null;
    if (c === "}") {
      if (i === start) return null;
      items.push(item);
      return { piece: { count: items.length, list: () => items }, end: i + 1 };
    }
    if (c === ",") {
      items.push(item);
      item = "";
    } else if (c === "\\" && i + 1 < text.length) {
      item += text[++i];
    } else {
      item += c;
    }
  }
  return null;
}

/** A `[N-M:step]` or `[a-z:step]` range after its `[`; anything else is curl's "bad range". */
function readRange(text: string, start: number): Parsed | null {
  const close = text.indexOf("]", start);
  if (close < 0) return null;
  const body = text.slice(start, close);
  const piece = numberRange(body) ?? letterRange(body);
  return piece ? { piece, end: close + 1 } : null;
}

function numberRange(body: string): Piece | null {
  const m = NUMBER_RANGE.exec(body);
  if (!m) return null;
  const [, minText = "", maxText = "", stepText = "1"] = m;
  const pad = minText.startsWith("0") ? minText.length : 0;
  return rangePiece(Number(minText), Number(maxText), Number(stepText), (n) => String(n).padStart(pad, "0"));
}

function letterRange(body: string): Piece | null {
  const m = LETTER_RANGE.exec(body);
  if (!m) return null;
  const [, minChar = "", maxChar = "", stepText = "1"] = m;
  const min = minChar.charCodeAt(0);
  const max = maxChar.charCodeAt(0);
  if (max - min > 25) return null;
  return rangePiece(min, max, Number(stepText), (code) => String.fromCharCode(code));
}

/** A well-formed range counted arithmetically and listed lazily, or null for curl's bad-range cases. */
function rangePiece(min: number, max: number, step: number, render: (n: number) => string): Piece | null {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(step)) return null;
  if (step < 1 || min > max || (min === max && step !== 1) || (min !== max && step > max - min)) return null;
  const count = Math.floor((max - min) / step) + 1;
  const list = (): string[] => Array.from({ length: count }, (_, k) => render(min + k * step));
  return { count, list };
}
