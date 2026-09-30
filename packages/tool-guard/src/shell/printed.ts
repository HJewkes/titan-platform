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
  return escapes ? decodeAnsiC(text) : text;
}

/** Handles `%s`, `%b`, `%d`, `%i` and `%%`, reusing the format while arguments remain, as printf does. */
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

function applyFormat(format: string, args: string[]): { text: string; used: number } | null {
  let used = 0;
  let understood = true;
  const text = format.replace(/%(.?)/g, (_, directive: string) => {
    if (directive === "%") return "%";
    if (!"sbdi".includes(directive) || directive === "") understood = false;
    const arg = args[used++] ?? "";
    return directive === "b" ? decodeAnsiC(arg) : arg;
  });
  return understood ? { text, used } : null;
}
