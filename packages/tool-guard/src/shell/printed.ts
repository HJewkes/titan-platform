import { decodeAnsiC, decodeEscapes } from "./ansi-c.js";
import type { WordToken } from "./lexer.js";

/**
 * The shell whose builtins print: zsh's echo takes a lone `-` as the end of its options and drops it, and bash's printf
 * counts width and precision in bytes where zsh's counts characters. Without one, echo keeps `-` and printf counts
 * characters.
 */
export type Shell = "bash" | "zsh";

/** Text `echo` or `printf` writes to stdout, or null when an argument is dynamic or the format is not understood. */
export function printedText(name: string | null, args: WordToken[], shell?: Shell): string | null {
  if (args.some((a) => a.dynamic)) return null;
  const values = args.map((a) => a.value);
  if (name === "echo") return echoText(values, shell === "zsh");
  if (name === "printf") return printfText(values[0] === "--" ? values.slice(1) : values, shell === "bash");
  return null;
}

/** Escapes are decoded unless `-E` is given: zsh's and sh's echo decode them by default. */
function echoText(values: string[], dashEndsOptions: boolean): string {
  let i = 0;
  let escapes = true;
  for (; i < values.length && /^-[neE]+$/.test(values[i] as string); i++) {
    const flags = values[i] as string;
    if (/[eE]/.test(flags)) escapes = flags.lastIndexOf("e") > flags.lastIndexOf("E");
  }
  if (dashEndsOptions && values[i] === "-") i++;
  const text = values.slice(i).join(" ");
  return escapes ? decodeAnsiC(text, "echo") : text;
}

/** Handles `%s`, `%b`, `%c`, `%d`, `%i` and `%%` with width and precision, reusing the format as printf does. */
function printfText(values: string[], bytes: boolean): string | null {
  const [format, ...args] = values;
  if (format === undefined || format.startsWith("-")) return null;
  let out = "";
  let rest = args;
  do {
    const pass = applyFormat(decodeAnsiC(format), rest, bytes);
    if (pass === null) return null;
    out += pass.text;
    if (pass.stopped || pass.used === 0) break;
    rest = rest.slice(pass.used);
  } while (rest.length > 0);
  return out;
}

const DIRECTIVE = /%([-+ #0]*)(\*|\d*)(?:\.(\*|\d*))?(.?)/g;

/** A `*` count printf would read as `-1` or `0x8` is not guessed: only plain decimals are understood. */
function applyFormat(format: string, args: string[], bytes: boolean): { text: string; used: number; stopped: boolean } | null {
  let used = 0;
  let understood = true;
  const next = () => args[used++] ?? "";
  const count = () => {
    const v = next();
    if (!/^\d+$/.test(v)) understood = false;
    return v;
  };
  let text = "";
  let at = 0;
  for (const m of format.matchAll(DIRECTIVE)) {
    const [whole, flags = "", width = "", precision, conv = ""] = m;
    text += format.slice(at, m.index);
    at = (m.index ?? 0) + whole.length;
    if (whole === "%%") {
      text += "%";
      continue;
    }
    if (!"sbcdi".includes(conv) || conv === "") understood = false;
    const w = width === "*" ? count() : width;
    const p = precision === "*" ? count() : precision;
    const arg = next();
    if (conv === "b" && decodeEscapes(arg, "printf-b").stopped) {
      return understood ? { text: text + convert(conv, arg, p, bytes), used, stopped: true } : null;
    }
    text += pad(convert(conv, arg, p, bytes), w, flags.includes("-"), bytes);
  }
  return understood ? { text: text + format.slice(at), used, stopped: false } : null;
}

/** `%.3s` truncates to three characters, the one directive that can turn `git push` into `git`. */
function convert(conv: string, arg: string, precision: string | undefined, bytes: boolean): string {
  const value = conv === "b" ? decodeAnsiC(arg, "printf-b") : conv === "c" ? leading(arg, 1, bytes) : arg;
  if (precision === undefined || !"sb".includes(conv)) return value;
  return leading(value, Number.parseInt(precision, 10) || 0, bytes);
}

/** A cut through a multibyte character leaves a broken byte, which decodes to U+FFFD and so never matches zsh's text. */
function leading(value: string, n: number, bytes: boolean): string {
  return bytes ? Buffer.from(value).subarray(0, n).toString() : value.slice(0, n);
}

function pad(value: string, width: string, left: boolean, bytes: boolean): string {
  const n = Number.parseInt(width, 10) || 0;
  const fill = " ".repeat(Math.max(0, n - (bytes ? Buffer.byteLength(value) : value.length)));
  return left ? value + fill : fill + value;
}
