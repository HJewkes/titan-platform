import { decodeAnsiC } from "./ansi-c.js";
import type { WordToken } from "./lexer.js";

/** Text `echo` or `printf` writes to stdout, or null when an argument is dynamic or the format is not understood. */
export function printedText(name: string | null, args: WordToken[]): string | null {
  if (args.some((a) => a.dynamic)) return null;
  const values = args.map((a) => a.value);
  if (name === "echo") return echoText(values);
  if (name === "printf") return printfText(values[0] === "--" ? values.slice(1) : values);
  return null;
}

/** Escapes are decoded unless `-E` is given: zsh's and sh's echo decode them by default. */
function echoText(values: string[]): string {
  let i = 0;
  let escapes = true;
  for (; i < values.length && /^-[neE]+$/.test(values[i] as string); i++) {
    const flags = values[i] as string;
    if (/[eE]/.test(flags)) escapes = flags.lastIndexOf("e") > flags.lastIndexOf("E");
  }
  const text = values.slice(i).join(" ");
  return escapes ? decodeAnsiC(text, "echo") : text;
}

/** Handles `%s`, `%b`, `%c`, `%d`, `%i` and `%%` with width and precision, reusing the format as printf does. */
function printfText(values: string[]): string | null {
  const [format, ...args] = values;
  if (format === undefined || format.startsWith("-")) return null;
  let out = "";
  let rest = args;
  do {
    const pass = applyFormat(decodeAnsiC(format), rest);
    if (pass === null) return null;
    out += pass.text;
    if (pass.used === 0) break;
    rest = rest.slice(pass.used);
  } while (rest.length > 0);
  return out;
}

const DIRECTIVE = /%([-+ #0]*)(\*|\d*)(?:\.(\*|\d*))?(.?)/g;

/** A `*` count printf would read as `-1` or `0x8` is not guessed: only plain decimals are understood. */
function applyFormat(format: string, args: string[]): { text: string; used: number } | null {
  let used = 0;
  let understood = true;
  const next = () => args[used++] ?? "";
  const count = () => {
    const v = next();
    if (!/^\d+$/.test(v)) understood = false;
    return v;
  };
  const text = format.replace(DIRECTIVE, (whole, flags: string, width: string, precision?: string, conv = "") => {
    if (whole === "%%") return "%";
    if (!"sbcdi".includes(conv) || conv === "") understood = false;
    const w = width === "*" ? count() : width;
    const p = precision === "*" ? count() : precision;
    return pad(convert(conv, next(), p), w, flags.includes("-"));
  });
  return understood ? { text, used } : null;
}

/** `%.3s` truncates to three characters, the one directive that can turn `git push` into `git`. */
function convert(conv: string, arg: string, precision: string | undefined): string {
  const value = conv === "b" ? decodeAnsiC(arg, "echo") : conv === "c" ? arg.slice(0, 1) : arg;
  if (precision === undefined || !"sb".includes(conv)) return value;
  return value.slice(0, Number.parseInt(precision, 10) || 0);
}

function pad(value: string, width: string, left: boolean): string {
  const n = Number.parseInt(width, 10) || 0;
  return left ? value.padEnd(n) : value.padStart(n);
}
