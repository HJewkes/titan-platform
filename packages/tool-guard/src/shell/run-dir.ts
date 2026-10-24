import { splitCluster, takesNextWord } from "./cluster.js";
import type { ClusterSpec } from "./cluster.js";
import type { WordToken } from "./lexer.js";
import type { SimpleCommand } from "./command-types.js";

/**
 * How one wrapper or runner names the directory it starts its command in: the short option letter and long options taking
 * it, and the letters and long options that pick the directory by a name only known at run time.
 */
interface ChdirSpec {
  short?: string;
  long: readonly string[];
  elsewhereShort?: string;
  elsewhereLong?: readonly string[];
}

/**
 * `env -C`, `sudo -D`, `pnpm -C`/`--dir`, `npm --prefix`, `yarn --cwd` and `bun --cwd` name the directory; `pnpm
 * --filter`/`-r`, `npm -w` and `bun --filter` pick a package by name, so the directory is only known at run time.
 */
const CHDIR: Readonly<Record<string, ChdirSpec>> = {
  env: { short: "C", long: ["--chdir"] },
  sudo: { short: "D", long: ["--chdir"] },
  pnpm: { short: "C", long: ["--dir"], elsewhereShort: "Frw", elsewhereLong: ["--filter", "--filter-prod", "--recursive", "--workspace-root"] },
  npm: { short: "C", long: ["--prefix"], elsewhereShort: "w", elsewhereLong: ["--workspace", "--workspaces"] },
  yarn: { long: ["--cwd"] },
  bun: { long: ["--cwd"], elsewhereShort: "F", elsewhereLong: ["--filter"] },
};

/** One option as the wrapper reads it: the directory it names (null when only known at run time), and whether it took the next word. */
interface Read {
  dir: WordToken | null | undefined;
  takesNext: boolean;
}

/**
 * The directory `name`'s own options, read before the command it runs, start that command in: the word naming it, null
 * when it is only known at run time, undefined when they leave the command where the line is. `options` are the words its
 * option parser read, long options spelled out, and `syntax` its option spec, so a cluster splits as getopt splits it
 * and another option's value (`env -uC/tmp`, `sudo -p -D/tmp`) is never read as a directory.
 */
export function runDirWord(name: string, options: readonly WordToken[], syntax: ClusterSpec): WordToken | null | undefined {
  const spec = Object.hasOwn(CHDIR, name) ? CHDIR[name] : undefined;
  if (spec === undefined) return undefined;
  let dir: WordToken | null | undefined;
  let i = 0;
  for (let word = options[i]; word !== undefined && word.value !== "--"; word = options[++i]) {
    const read = readOption(word, options[i + 1], spec, syntax);
    if (read.takesNext) i++;
    if (read.dir !== undefined) dir = dir === null ? null : read.dir;
  }
  return dir;
}

function readOption(word: WordToken, next: WordToken | undefined, spec: ChdirSpec, syntax: ClusterSpec): Read {
  if (word.dynamic) return { dir: null, takesNext: false };
  return word.value.startsWith("--") ? readLong(word, next, spec, syntax) : readShort(word, next, spec, syntax);
}

function readLong(word: WordToken, next: WordToken | undefined, spec: ChdirSpec, syntax: ClusterSpec): Read {
  const eq = word.value.indexOf("=");
  const name = eq < 0 ? word.value : word.value.slice(0, eq);
  const takesNext = eq < 0 && takesNextWord(name, syntax);
  if (spec.long.includes(name)) return { dir: eq < 0 ? known(next) : { ...word, value: word.value.slice(eq + 1) }, takesNext };
  return { dir: spec.elsewhereLong?.includes(name) ? null : undefined, takesNext };
}

function readShort(word: WordToken, next: WordToken | undefined, spec: ChdirSpec, syntax: ClusterSpec): Read {
  const cluster = splitCluster(word.value, syntax);
  if (cluster === null) return { dir: undefined, takesNext: false };
  const { flags, end } = cluster;
  const takesNext = end !== null && !end.optional && end.text === "";
  const elsewhere = [...flags, end?.option ?? ""].some((letter) => letter !== "" && spec.elsewhereShort?.includes(letter));
  if (elsewhere) return { dir: null, takesNext };
  if (end === null || end.option !== spec.short) return { dir: undefined, takesNext };
  return { dir: takesNext ? known(next) : { ...word, value: end.text }, takesNext };
}

function known(word: WordToken | undefined): WordToken | null {
  return word === undefined || word.dynamic ? null : word;
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
