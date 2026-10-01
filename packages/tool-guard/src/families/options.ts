import type { WordToken } from "../shell/lexer.js";

export interface Option {
  /** `--long` or a single `-x` letter, without any attached value. */
  flag: string;
  value: WordToken | null;
}

export interface Options {
  opts: Option[];
  positionals: WordToken[];
}

/** Splits a command's words into options with their values and positionals; `values` names options that take one. */
export function readOptions(args: WordToken[], values: ReadonlySet<string>): Options {
  const out: Options = { opts: [], positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as WordToken;
    const v = word.value;
    if (v === "--") {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (v.startsWith("--")) i += readLong(word, args[i + 1], values, out.opts);
    else if (v.startsWith("-") && v.length > 1) i += readShort(word, args[i + 1], values, out.opts);
    else out.positionals.push(word);
  }
  return out;
}

function readLong(word: WordToken, next: WordToken | undefined, values: ReadonlySet<string>, opts: Option[]): number {
  const eq = word.value.indexOf("=");
  if (eq > 0) {
    opts.push({ flag: word.value.slice(0, eq), value: { ...word, value: word.value.slice(eq + 1) } });
    return 0;
  }
  const takes = values.has(word.value);
  opts.push({ flag: word.value, value: takes ? (next ?? null) : null });
  return takes ? 1 : 0;
}

/** A cluster such as `-sSL` or `-XPOST`: the first letter that takes a value consumes the rest, or the next word. */
function readShort(word: WordToken, next: WordToken | undefined, values: ReadonlySet<string>, opts: Option[]): number {
  const v = word.value;
  for (let j = 1; j < v.length; j++) {
    const flag = `-${v[j]}`;
    if (!values.has(flag)) {
      opts.push({ flag, value: null });
      continue;
    }
    if (j < v.length - 1) {
      opts.push({ flag, value: { ...word, value: v.slice(j + 1) } });
      return 0;
    }
    opts.push({ flag, value: next ?? null });
    return 1;
  }
  return 0;
}

export function hasFlag(options: Options, ...flags: string[]): boolean {
  return options.opts.some((o) => flags.includes(o.flag));
}

/** The value of the last of `flags` given, as git and curl let a later option win. */
export function lastValue(options: Options, ...flags: string[]): WordToken | null {
  const hit = options.opts.filter((o) => flags.includes(o.flag)).at(-1);
  return hit?.value ?? null;
}

export function valuesOf(options: Options, ...flags: string[]): WordToken[] {
  return options.opts.flatMap((o) => (flags.includes(o.flag) && o.value ? [o.value] : []));
}

export const set = (...items: string[]): ReadonlySet<string> => new Set(items);
