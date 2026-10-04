import type { WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";

const GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source", "--super-prefix"]);

export interface GitInvocation {
  /** Directory git operates in after `-C`, null when unknown. */
  dir: string | null;
  /** Paths from `--git-dir` and `--work-tree`; any entry means `dir` alone does not locate the repository. */
  otherPaths: Array<string | null>;
  /** `-c key=value` overrides. */
  config: string[];
  sub: string | null;
  /** True when the subcommand is, or an unquoted dynamic option word could split into, a word git could run as anything. */
  subDynamic: boolean;
  subArgs: WordToken[];
}

/** Parses `git [global options] <subcommand> [args]` and resolves where it operates. */
export function parseGit(args: WordToken[], dir: string | null, home: string | null = null): GitInvocation {
  const inv: GitInvocation = { dir, otherPaths: [], config: [], sub: null, subDynamic: false, subArgs: [] };
  let i = 0;
  for (; i < args.length && (args[i] as WordToken).value.startsWith("-"); i++) {
    const { flag, value, width } = option(args, i, GLOBAL_VALUE_OPTS);
    inv.subDynamic ||= splits(args[i]) || splits(value);
    i += width - 1;
    if (flag === "-C") inv.dir = resolvePath(inv.dir, value, home);
    else if (flag === "--git-dir" || flag === "--work-tree") inv.otherPaths.push(resolvePath(inv.dir, value, home));
    else if (flag === "-c" && value) inv.config.push(value.value);
  }
  const sub = args[i];
  if (sub?.dynamic) inv.subDynamic = true;
  else if (sub) {
    inv.sub = sub.value;
    inv.subArgs = args.slice(i + 1);
  }
  return inv;
}

/** An unquoted dynamic word word-splits, so it can carry the subcommand itself. */
const splits = (word: WordToken | null | undefined) => Boolean(word?.dynamic && (!word.quoted || word.unquotedExpansion));

function option(args: WordToken[], i: number, valueOpts: Set<string>) {
  const word = args[i] as WordToken;
  const v = word.value;
  const eq = v.startsWith("--") ? v.indexOf("=") : -1;
  if (eq > 0) return { flag: v.slice(0, eq), value: { ...word, value: v.slice(eq + 1) }, width: 1 };
  if (valueOpts.has(v)) return { flag: v, value: args[i + 1] ?? null, width: 2 };
  return { flag: v, value: null, width: 1 };
}

export interface SplitArgs {
  /** Normalised to `--long` names and single `-x` letters. */
  flags: Set<string>;
  positionals: WordToken[];
}

/** Separates flags from positionals; `valueOpts` names options whose value is the next word. */
export function splitArgs(args: WordToken[], valueOpts: Set<string> = new Set()): SplitArgs {
  const flags = new Set<string>();
  const positionals: WordToken[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (v.startsWith("--")) {
      const { flag, width } = option(args, i, valueOpts);
      flags.add(flag);
      i += width - 1;
    } else if (v.startsWith("-") && v.length > 1) i += addShortCluster(v, flags, valueOpts);
    else positionals.push(args[i] as WordToken);
  }
  return { flags, positionals };
}

function addShortCluster(v: string, flags: Set<string>, valueOpts: Set<string>): number {
  for (let j = 1; j < v.length; j++) {
    flags.add(`-${v[j]}`);
    if (valueOpts.has(`-${v[j]}`)) return j === v.length - 1 ? 1 : 0;
  }
  return 0;
}
