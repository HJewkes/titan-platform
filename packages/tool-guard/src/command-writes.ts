import type { SimpleCommand } from "./shell/commands.js";
import { basename, resolvePath } from "./shell/path.js";
import type { WordToken } from "./shell/tokens.js";

/** What the line knows of a path: a file with readings, nothing there, or something the guard cannot read as a file. */
export type Presence = "file" | "absent" | "other";

/**
 * A file a command writes by name. `copy` leaves `to` holding what `from` holds; `untracked` is a write of text the guard
 * does not reproduce; `tree` is that for a path and everything under it; `anywhere` is a write it cannot place at all.
 */
export type NamedWrite =
  | { kind: "copy"; from: string; to: string }
  | { kind: "untracked"; path: string }
  | { kind: "tree"; path: string }
  | { kind: "anywhere" };

const ANYWHERE: NamedWrite = { kind: "anywhere" };
/** Short options of cp, mv, install and ln that take a value; `-t` names the destination directory. */
const VALUE_SHORT = "tSmog";
const VALUE_LONG = new Set(["target-directory", "suffix", "mode", "owner", "group"]);
/** `dd` operands that change how much of `of=` is written or where, so the file ends up holding a mix. */
const DD_PARTIAL_RE = /^(conv|seek|oseek|oflag|skip|iseek|iflag|count)=/;

interface Parsed {
  operands: WordToken[];
  targetDir: WordToken | null;
  flags: Set<string>;
}

/** The files `cmd` writes by name (tee, cp, mv, install, ln, dd), as the line may leave them. */
export function namedWrites(cmd: SimpleCommand, presence: (path: string) => Presence, home: string | null): NamedWrite[] {
  const at = (word: WordToken | null | undefined): string | null => resolvePath(cmd.dir, word, home);
  switch (cmd.name) {
    case "tee":
      return teeWrites(cmd, at);
    case "cp":
    case "mv":
    case "install":
    case "ln":
      return transferWrites(cmd, presence, at);
    case "dd":
      return ddWrites(cmd, presence, at);
    default:
      return [];
  }
}

/** The text is stdin, which the model does not follow into the file, so each file operand is left untracked. */
function teeWrites(cmd: SimpleCommand, at: (w: WordToken) => string | null): NamedWrite[] {
  const parsed = parseArgs(cmd.args, "", new Set());
  if (parsed === null) return [ANYWHERE];
  return parsed.operands.map((w) => {
    const path = at(w);
    return path === null ? ANYWHERE : { kind: "untracked", path };
  });
}

function ddWrites(cmd: SimpleCommand, presence: (path: string) => Presence, at: (w: WordToken) => string | null): NamedWrite[] {
  const out = cmd.args.find((w) => w.value.startsWith("of="));
  if (out === undefined) return [];
  const target = at({ ...out, value: out.value.slice(3) });
  if (target === null || out.dynamic) return [ANYWHERE];
  const input = cmd.args.find((w) => w.value.startsWith("if="));
  const from = input === undefined || input.dynamic ? null : at({ ...input, value: input.value.slice(3) });
  const partial = cmd.args.some((w) => DD_PARTIAL_RE.test(w.value));
  return from === null || partial || presence(from) !== "file" ? [{ kind: "untracked", path: target }] : [{ kind: "copy", from, to: target }];
}

function transferWrites(cmd: SimpleCommand, presence: (path: string) => Presence, at: (w: WordToken) => string | null): NamedWrite[] {
  const parsed = parseArgs(cmd.args, VALUE_SHORT, VALUE_LONG);
  if (parsed === null || parsed.flags.has("parents")) return [ANYWHERE];
  if (cmd.name === "install" && (parsed.flags.has("d") || parsed.flags.has("directory"))) return [];
  const { operands, targetDir } = parsed;
  if (targetDir === null && operands.length < 2) return cmd.name === "ln" && operands.length === 1 ? lnHere(cmd, operands[0]) : [];
  const last = operands.at(-1);
  const destWord = targetDir ?? last;
  if (destWord === undefined) return [];
  const sources = targetDir === null ? operands.slice(0, -1) : operands;
  const dest = at(destWord);
  if (dest === null) return [ANYWHERE];
  const asDir = targetDir !== null || sources.length > 1 || destWord.value.endsWith("/");
  const noDir = parsed.flags.has("T") || parsed.flags.has("no-target-directory");
  const slots = {
    asFile: !asDir,
    mayBeDir: !noDir && (asDir || presence(dest) !== "file"),
    symlink: cmd.name === "ln" && (parsed.flags.has("s") || parsed.flags.has("symbolic")),
  };
  return sources.flatMap((w) => placed(at(w), dest, slots, presence));
}

/** `ln TARGET` links it into the working directory under its own name. */
function lnHere(cmd: SimpleCommand, source: WordToken | undefined): NamedWrite[] {
  const name = source === undefined || source.dynamic ? null : basename(source.value);
  return cmd.dir === null || name === null || name === "" ? [ANYWHERE] : [{ kind: "untracked", path: `${cmd.dir}/${name}` }];
}

interface Slots {
  /** `dest` itself may be the new file. */
  asFile: boolean;
  /** `dest` may be a directory, so the new file is `dest/<name of the source>`. */
  mayBeDir: boolean;
  /** A symlink holds a path resolved from its own directory, which the model does not follow. */
  symlink: boolean;
}

function placed(from: string | null, dest: string, slots: Slots, presence: (path: string) => Presence): NamedWrite[] {
  const state = from === null ? "other" : presence(from);
  if (state === "absent" && !slots.symlink) return [];
  if (from === null || state === "other") return [{ kind: "tree", path: dest }];
  const targets = [...(slots.asFile ? [dest] : []), ...(slots.mayBeDir ? [`${dest.replace(/\/+$/, "")}/${basename(from)}`] : [])];
  return targets.map((to) => (slots.symlink ? { kind: "untracked", path: to } : { kind: "copy", from, to }));
}

/** Splits arguments into options and operands; null when a word could hide an option or several operands. */
function parseArgs(args: WordToken[], valueShort: string, valueLong: ReadonlySet<string>): Parsed | null {
  const parsed: Parsed = { operands: [], targetDir: null, flags: new Set() };
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    if (word.dynamic && (word.unquotedExpansion || word.value.startsWith("-"))) return null;
    if (ended || word.dynamic || !word.value.startsWith("-") || word.value === "-") parsed.operands.push(word);
    else if (word.value === "--") ended = true;
    else {
      const used = word.value.startsWith("--") ? longOption(word, args[i + 1], parsed, valueLong) : shortCluster(word, args[i + 1], parsed, valueShort);
      if (used === null) return null;
      i += used;
    }
  }
  return parsed;
}

/** How many following words the option took as its value, null when it needs one that is missing. */
function longOption(word: WordToken, next: WordToken | undefined, parsed: Parsed, valueLong: ReadonlySet<string>): number | null {
  const [name = "", inline] = word.value.slice(2).split(/=(.*)/s);
  parsed.flags.add(name);
  if (!valueLong.has(name)) return 0;
  const value = inline !== undefined ? { ...word, value: inline } : next;
  if (value === undefined) return null;
  if (name === "target-directory") parsed.targetDir = value;
  return inline !== undefined ? 0 : 1;
}

function shortCluster(word: WordToken, next: WordToken | undefined, parsed: Parsed, valueShort: string): number | null {
  const letters = word.value.slice(1);
  for (const [k, letter] of [...letters].entries()) {
    if (!valueShort.includes(letter)) {
      parsed.flags.add(letter);
      continue;
    }
    const rest = letters.slice(k + 1);
    const value = rest !== "" ? { ...word, value: rest } : next;
    if (value === undefined) return null;
    if (letter === "t") parsed.targetDir = value;
    return rest !== "" ? 0 : 1;
  }
  return 0;
}
