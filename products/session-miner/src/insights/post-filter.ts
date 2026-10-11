import { createHash } from "node:crypto";
import path from "node:path";
import { simpleCommandHead, splitPipelines, type ShellWord } from "@titan-design/session-read";

/** One pipeline whose head is one of our CLIs and which pipes its output on through a post-filter. */
export interface PostFilterUse {
  /** The CLI and its subcommands (`agent-chat agent ls`, `gh api GET pulls`, `sqlite3 events.db`). */
  head: string;
  /** The words `--help` is appended to when checking what the CLI already offers. */
  helpArgv: string[];
  /** The flags the head passed, as written up to any `=`, sorted. */
  headFlags: string[];
  /** The normalised pipe tail, such as `| grep -E | head`. */
  pattern: string;
  /** Each tail stage, normalised, in pipe order. */
  stages: string[];
}

/** Heads whose post-filters count; `sqlite3` counts only on a database named in `OUR_DB`. */
export const OUR_CLIS = ["active-work", "agent-chat", "titan-factory", "basement-suite", "gh", "sqlite3"] as const;

const OURS: ReadonlySet<string> = new Set(OUR_CLIS);
/** agent-chat's events log, the session graph and the miner's own index, or anything under their state directories. */
const OUR_DB = /(?:^|\/)(?:\.agent-chat|active-work|titan-[\w-]+)\/|(?:^|\/)(?:events\.db|graph\.sqlite3|index\.sqlite3)$/;
/** Positional operands follow these programs directly, so their help never takes subcommand words. */
const NO_SUBCOMMANDS = new Set(["basement-suite", "sqlite3"]);
const SSH_VALUE_FLAGS = new Set(["-o", "-p", "-i", "-l", "-F", "-J", "-E", "-b", "-c", "-D", "-L", "-R", "-W"]);
/** `head -n 5` and `head -5` read the same; only the count differs. */
const DEFAULT_FLAG: Record<string, string> = { head: "-n", tail: "-n" };
const INLINE_CODE = new Set(["python", "python3", "node"]);
const MENTIONS_JSON = /\bjson\b|JSON\./;
const REDIRECT = /^(?:\d*|&)[<>]/;

/** Every pipeline in a raw Bash command that starts at one of our CLIs and has at least one stage after it. */
export function postFilters(command: string): PostFilterUse[] {
  return ourPipelines(command).filter((use) => use.stages.length > 0);
}

/** Every pipeline in a raw Bash command that starts at one of our CLIs, piped on or not; an unpiped one has an empty pattern. */
export function ourPipelines(command: string): PostFilterUse[] {
  const uses: PostFilterUse[] = [];
  for (const [first, ...tail] of splitPipelines(command)) {
    const head = first ? ourHead(throughSsh(first)) : null;
    if (!head) continue;
    const stages = tail.map(normaliseStage);
    uses.push({ ...head, pattern: stages.length > 0 ? `| ${stages.join(" | ")}` : "", stages });
  }
  return uses;
}

/** A short, stable id for a normalised pattern: the same tail gives the same id in every run and every corpus. */
export function patternId(pattern: string): string {
  return `pf-${createHash("sha256").update(pattern).digest("hex").slice(0, 12)}`;
}

/** One tail stage reduced to its program and flag names: operands, flag values, counts and redirects drop out. */
export function normaliseStage(words: readonly ShellWord[]): string {
  const program = simpleCommandHead(words)?.split(" ")[0] ?? words[0]?.text ?? "";
  const flags = new Set(unredirected(words).flatMap(shortOrLongFlags));
  flags.delete(DEFAULT_FLAG[program] ?? "");
  const code = INLINE_CODE.has(program) && words.some((w) => w.quoted && MENTIONS_JSON.test(w.text)) ? ["json"] : [];
  return [program, ...[...flags].sort(), ...code].join(" ");
}

function ourHead(words: readonly ShellWord[]): Omit<PostFilterUse, "pattern" | "stages"> | null {
  const head = simpleCommandHead(words);
  const program = head?.split(" ")[0];
  if (!head || !program || !OURS.has(program)) return null;
  const headFlags = [...new Set(unredirected(words).filter(isFlag).map((w) => w.text.split("=")[0]!))].sort();
  if (program === "sqlite3") {
    const db = words.find((w) => OUR_DB.test(w.text));
    return db ? { head: `sqlite3 ${path.basename(db.text)}`, helpArgv: ["sqlite3"], headFlags } : null;
  }
  if (NO_SUBCOMMANDS.has(program)) return { head: program, helpArgv: [program], headFlags };
  return { head, helpArgv: head.startsWith("gh api") ? ["gh", "api"] : head.split(" "), headFlags };
}

/** `ssh host cmd args` runs `cmd` remotely; a quoted remote command is one string, which is left alone. */
function throughSsh(words: readonly ShellWord[]): readonly ShellWord[] {
  if (words[0]?.text !== "ssh" || words[0].quoted) return words;
  let i = 1;
  while (i < words.length && words[i]!.text.startsWith("-")) i += SSH_VALUE_FLAGS.has(words[i]!.text) ? 2 : 1;
  const remote = words.slice(i + 1);
  return remote.length > 0 && !remote[0]!.quoted ? remote : words;
}

function unredirected(words: readonly ShellWord[]): ShellWord[] {
  const kept: ShellWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.quoted || !REDIRECT.test(word.text)) kept.push(word);
    else if (/^(?:\d*|&)[<>]+&?$/.test(word.text)) i++;
  }
  return kept;
}

/** A quoted word counts only when it opens like a flag, so `-d'|'` keeps its `-d`. */
function isFlag(word: ShellWord): boolean {
  return /^-{1,2}[A-Za-z]/.test(word.text);
}

/** `-Ev` gives `-E` and `-v`, `-A15` gives `-A`, `--lines=5` gives `--lines`; a bare count such as `-5` gives nothing. */
function shortOrLongFlags(word: ShellWord): string[] {
  if (!isFlag(word)) return [];
  const long = /^--([A-Za-z][\w-]*)/.exec(word.text);
  if (long) return [`--${long[1]}`];
  const letters = /^-([A-Za-z]+)/.exec(word.text)?.[1] ?? "";
  return [...letters].map((letter) => `-${letter}`);
}
