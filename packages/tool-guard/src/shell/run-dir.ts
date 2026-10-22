import type { WordToken } from "./lexer.js";
import type { SimpleCommand } from "./command-types.js";

/** How one wrapper or runner names the directory it starts its command in: the option letters and long names taking it, and options that move it somewhere the line does not show. */
interface ChdirSpec {
  short?: RegExp;
  long?: readonly string[];
  elsewhere?: RegExp;
}

/**
 * `env -C`, `sudo -D`, `pnpm -C`/`--dir`, `npm --prefix`, `yarn --cwd` and `bun --cwd` name the directory; `pnpm
 * --filter`/`-r`, `npm -w` and `bun --filter` pick a package by name, so the directory is only known at run time.
 */
const CHDIR: Readonly<Record<string, ChdirSpec>> = {
  env: { short: /^-[A-Za-z0-9]*?C(.*)$/, long: ["--chdir"] },
  sudo: { short: /^-[A-Za-z0-9]*?D(.*)$/, long: ["--chdir"] },
  pnpm: { short: /^-[A-Za-z0-9]*?C(.*)$/, long: ["--dir"], elsewhere: /^(?:-[A-Za-z]*[Frw]|--(?:filter|recursive|workspace-root|filter-prod)(?:=|$))/ },
  npm: { short: /^-[A-Za-z0-9]*?C(.*)$/, long: ["--prefix"], elsewhere: /^(?:-[A-Za-z]*w|-ws$|--workspaces?(?:=|$))/ },
  yarn: { long: ["--cwd"] },
  bun: { long: ["--cwd"], elsewhere: /^(?:--filter(?:=|$)|-[A-Za-z]*F)/ },
};

/**
 * The directory `name`'s own options, read before the command it runs, start that command in: the word naming it, null
 * when it is only known at run time, undefined when they leave the command where the line is.
 */
export function runDirWord(name: string, options: readonly WordToken[]): WordToken | null | undefined {
  const spec = Object.hasOwn(CHDIR, name) ? CHDIR[name] : undefined;
  if (spec === undefined) return undefined;
  let dir: WordToken | null | undefined;
  for (let i = 0; i < options.length; i++) {
    const word = options[i] as WordToken;
    const operand = word.dynamic ? undefined : chdirOperand(word.value, spec);
    if (operand !== undefined) {
      const named = operand === null ? options[++i] : { ...word, value: operand };
      dir = dir === null || named === undefined || named.dynamic ? null : named;
    } else if (word.dynamic || spec.elsewhere?.test(word.value)) dir = null;
  }
  return dir;
}

/** The directory an option word holds (`-Cdir`, `--chdir=dir`), null when it takes the next word, undefined when it names none. */
function chdirOperand(value: string, spec: ChdirSpec): string | null | undefined {
  for (const long of spec.long ?? []) {
    if (value === long) return null;
    if (value.startsWith(`${long}=`)) return value.slice(long.length + 1);
  }
  if (spec.short === undefined || value.startsWith("--")) return undefined;
  const rest = spec.short.exec(value)?.[1];
  if (rest === undefined) return undefined;
  return rest === "" ? null : rest;
}

/** The directory a command's own arguments resolve from: where a wrapper started it, else where the line is. */
export function argDir(cmd: Pick<SimpleCommand, "dir" | "runDir">): string | null {
  return cmd.runDir === undefined ? cmd.dir : cmd.runDir;
}

/** A relative directory a nested wrapper names is relative to where the outer one started it, so an unknown outer one stays unknown. */
export function movedTo(outer: WordToken | null | undefined, inner: WordToken | null | undefined): WordToken | null | undefined {
  if (inner === undefined) return outer;
  if (outer === undefined || inner === null) return inner;
  if (outer === null || outer.dynamic) return null;
  return /^(?:\/|~(?:\/|$))/.test(inner.value) ? inner : { ...inner, value: `${outer.value.replace(/\/+$/, "")}/${inner.value}` };
}

export function ranIn(runDir: WordToken | null | undefined): { runDir?: WordToken | null } {
  return runDir === undefined ? {} : { runDir };
}
