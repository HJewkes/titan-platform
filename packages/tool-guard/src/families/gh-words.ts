import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";
import { set } from "./options.js";

/*
 * gh's command words as gh 2.102 finds them, moved from agent-chat's leak-guard (`src/leak-guard/gh-runs.ts`). Until
 * TP-641's swap-back, both copies hold these tables; a gh bump re-runs leak-guard's probe list and updates both.
 */

/**
 * The words gh runs as its own commands before any alias or extension: `gh help` on gh 2.102,
 * plus the hidden commands, help topics and command aliases it also accepts. A config alias
 * shadows `co`, `help`, `__complete` and `__completeNoDesc` (probed on 2.102), so they are left out.
 */
export const GH_BUILTINS: ReadonlySet<string> = new Set(
  `a11y accessibility actions agent agent-task agents alias api at attestation auth browse cache
  codespace completion config copilot credits cs discussion environment exit-codes ext extension
  extensions formatting gist gpg-key issue label licenses mintty org pr preview project reference
  release repo rs ruleset run search secret skill skills ssh-key status telemetry variable
  version workflow`.split(/\s+/),
);

const subcommands = (groups: string, words: string): [string, ReadonlySet<string>][] => {
  const members = new Set(words.split(/\s+/));
  return groups.split(" ").map((group) => [group, members]);
};

/**
 * Each gh command's own subcommands and their aliases (gh 2.102, `gh __complete <group>` and each
 * subcommand's ALIASES), which gh runs before a `group word` config alias of the same name.
 */
export const GH_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...subcommands("agent-task", "create list view"),
  ...subcommands("alias", "delete import list ls set"),
  ...subcommands("attestation", "download trusted-root verify"),
  ...subcommands("auth", "git-credential login logout refresh setup-git status switch token"),
  ...subcommands("cache", "delete list ls"),
  ...subcommands("codespace", "code cp create delete edit jupyter list ls logs ports rebuild ssh stop view"),
  ...subcommands("config", "clear-cache get list ls set"),
  ...subcommands("discussion", "comment create edit list ls view"),
  ...subcommands("extension", "browse create exec install list ls remove uninstall search upgrade"),
  ...subcommands("gist", "clone create new delete edit list ls rename view"),
  ...subcommands("gpg-key ssh-key", "add delete list ls"),
  ...subcommands(
    "issue",
    `close comment create new delete develop edit list ls lock pin reopen status transfer unlock
    unpin view`,
  ),
  ...subcommands("label", "clone create delete edit list ls"),
  ...subcommands("org", "list ls"),
  ...subcommands(
    "pr",
    `checkout co checks close comment create new diff edit list ls lock merge ready reopen revert
    review status unlock update-branch view`,
  ),
  ...subcommands("preview", "prompter"),
  ...subcommands(
    "project",
    `close copy create delete edit field-create field-delete field-list item-add item-archive
    item-create item-delete item-edit item-list link list ls mark-template unlink view`,
  ),
  ...subcommands("release", "create new delete delete-asset download edit list ls upload verify verify-asset view"),
  ...subcommands(
    "repo",
    `archive autolink clone create new delete deploy-key edit fork gitignore license list ls
    read-dir read-file rename set-default sync unarchive view`,
  ),
  ...subcommands("ruleset", "check list ls view"),
  ...subcommands("run", "cancel delete download list ls rerun view watch"),
  ...subcommands("search", "code commits issues prs repos"),
  ...subcommands("secret", "delete remove list ls set"),
  ...subcommands("skill", "install add list ls preview show publish search update"),
  ...subcommands("variable", "delete remove get list ls set"),
  ...subcommands("workflow", "disable enable list ls run view"),
]);

/** gh's command aliases, by the name gh resolves them to (gh 2.102 ALIASES). */
export const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["a11y", "accessibility"],
  ["agent", "agent-task"],
  ["agents", "agent-task"],
  ["at", "attestation"],
  ["cs", "codespace"],
  ["ext", "extension"],
  ["extensions", "extension"],
  ["rs", "ruleset"],
  ["skills", "skill"],
]);

/** gh commands that never run a `<command> <word>` config alias (probed on gh 2.102). */
export const NO_ALIAS_CHILD = set("accessibility", "api", "browse", "completion", "credits", "licenses", "status", "version");

/**
 * The second-level commands that run a `<command> <sub> <word>` config alias, with their own
 * subcommands. `codespace ports` has subcommands too but runs, and takes no alias (probed).
 */
export const NESTED_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["repo autolink", set("create", "new", "delete", "list", "ls", "view")],
  ["repo deploy-key", set("add", "delete", "list", "ls")],
  ["repo gitignore", set("list", "ls", "view")],
  ["repo license", set("list", "ls", "view")],
]);

/**
 * Where an alias may hang: the canonical path of the gh command it hangs under ('' for the top
 * level), the word that names it (undefined when the guard cannot resolve that word), and how
 * many command words reach it.
 */
export interface AliasSlot {
  parent: string;
  word: string | undefined;
  used: number;
}

/**
 * The alias slot that command words reach, as gh 2.102 finds it: command aliases resolve to
 * their command, real subcommands are walked, and the first word that is not one names the alias.
 * Undefined when the words end on a gh command or reach one that takes no alias.
 */
export function ghAliasSlot(words: readonly (string | undefined)[]): AliasSlot | undefined {
  const [first, second, third] = words;
  if (words.length === 0) return undefined;
  if (first === undefined || !GH_BUILTINS.has(first)) return { parent: "", word: first, used: 1 };
  const top = COMMAND_ALIASES.get(first) ?? first;
  if (NO_ALIAS_CHILD.has(top) || words.length < 2) return undefined;
  if (second === undefined || !GH_SUBCOMMANDS.get(top)?.has(second)) return { parent: top, word: second, used: 2 };
  const nested = NESTED_GROUPS.get(`${top} ${second}`);
  if (nested === undefined || words.length < 3 || (third !== undefined && nested.has(third))) return undefined;
  return { parent: `${top} ${second}`, word: third, used: 3 };
}

/**
 * The second-level commands with subcommands of their own that take no `<command> <sub> <word>` alias, so a word
 * that names none of them is an argument. The full gh 2.102 tree has this one beside `NESTED_GROUPS`: every
 * second-level command reachable by `gh <group> <sub> --help` lists no subcommands but these, and the binary's
 * `<name> <command>` group strings below the top level are the `repo` ones only.
 */
const NO_ALIAS_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([["codespace ports", set("forward", "visibility")]]);

/** Commands whose first argument names an installed extension that gh runs, as `gh <extension>` would. */
const EXTENSION_RUNNERS = set("extension exec");

/** The command gh runs for a line's arguments, read the way cobra v1.10's `Find` reads them. */
export interface GhCommandLine {
  /** The command words cobra finds, the top one canonical (`cs` reads `codespace`), ending at an alias slot's word. */
  path: string[];
  /** The arguments minus the command words, which the found command's own flags parse (cobra `argsMinusFirstX`). */
  leaf: WordToken[];
  /** The path ends on a word gh may run as a config alias or an extension. */
  aliasSlot: boolean;
  /** A word only known at run time, or one that may split, sits where cobra may read a command word. */
  hidden: boolean;
}

/**
 * gh's root flags that take no value, so they never take the next word; `--help` is persistent and reaches every
 * level, `--version` is the root's own. `-h` is not one: gh defines `--help` with no shorthand, so cobra lets `-h`
 * take the next word (probed on gh 2.102: `gh -h repo` prints the root's help).
 */
const ROOT_BOOLS = set("--help", "--version");
const LEVEL_BOOLS = set("--help");

/**
 * Finds gh's command words level by level, as cobra's `Find` does: at each level `stripFlags` names the first
 * command word and `argsMinusFirstX` removes it, until a command with no subcommands or an alias slot is reached.
 * Under a group that takes no alias, a word that names none of its subcommands stays an argument.
 */
export function ghCommandLine(args: WordToken[]): GhCommandLine {
  const path: string[] = [];
  let rest = args;
  while (takesCommandWord(path)) {
    const at = nextCommandWord(rest, path.length === 0 ? ROOT_BOOLS : LEVEL_BOOLS);
    if (at === "unknown") return { path, leaf: rest, aliasSlot: false, hidden: true };
    if (at === "none") break;
    const word = rest[at]!.value;
    if (NO_ALIAS_GROUPS.get(path.join(" "))?.has(word) === false) break;
    path.push(path.length === 0 ? (COMMAND_ALIASES.get(word) ?? word) : word);
    rest = rest.filter((_, i) => i !== at);
  }
  return { path, leaf: rest, aliasSlot: ghAliasSlot(path) !== undefined || runsExtension(path), hidden: false };
}

const runsExtension = (path: readonly string[]) => path.length === 3 && EXTENSION_RUNNERS.has(path.slice(0, 2).join(" "));

/** Whether the command a path names may have a subcommand or alias under it, so cobra reads another command word. */
function takesCommandWord(path: readonly string[]): boolean {
  if (path.length === 0) return true;
  if (ghAliasSlot(path) !== undefined) return false;
  if (path.length === 1) return !NO_ALIAS_CHILD.has(path[0]!);
  const key = path.join(" ");
  return path.length === 2 && (NESTED_GROUPS.has(key) || NO_ALIAS_GROUPS.has(key) || EXTENSION_RUNNERS.has(key));
}

/**
 * The index of the first command word, as cobra's `stripFlags` finds it: `--` ends the search, an option without
 * `=` that is not a known no-value flag (`--x`, or a two-character `-x`) takes the next word, any other option or
 * an empty word is skipped. "unknown" when a word that may split, or one only known at run time, could change that.
 */
function nextCommandWord(words: WordToken[], bools: ReadonlySet<string>): number | "none" | "unknown" {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (maySplit(word)) return "unknown";
    if (word.value === "--" && !word.dynamic) return "none";
    const width = optionWidth(word, bools);
    if (width === null || (width === 2 && maySplit(words[i + 1]))) return "unknown";
    if (width === 0) return /\s/.test(word.value) ? "unknown" : i;
    i += width - 1;
  }
  return "none";
}

/**
 * How many words a word spans as an option: 0 for a command word, 1 for an option alone, 2 for an option that takes
 * the next word, null when a run-time value decides. A run-time word is an option of width 1 only when its written
 * text already attaches a value (`--repo="$R"`, `-R"$R"`).
 */
function optionWidth(word: WordToken, bools: ReadonlySet<string>): 0 | 1 | 2 | null {
  const v = word.value;
  if (word.dynamic || isCaseUnsure(word)) return v.startsWith("-") && attachesValue(word) ? 1 : null;
  if (v === "") return 1;
  if (!v.startsWith("-")) return 0;
  if (v.includes("=") || bools.has(v)) return 1;
  return v.startsWith("--") || v.length === 2 ? 2 : 1;
}

/** gh options that take a value and may sit before the group; `-R` is the one a short cluster attaches. */
const VALUE_OPTS = set("-R", "--repo", "--hostname");

/** Whether an option word's own value starts inside it (`--repo=x`, `-Rx`) no later than its first run-time text. */
function attachesValue(word: WordToken): boolean {
  const valueAt = attachedValueAt(word.value);
  return valueAt !== null && valueAt <= firstDynamic(word);
}

/** Where an option's own value starts inside its word (`--repo=x`, `-Rx`), null when it has none there. */
function attachedValueAt(v: string): number | null {
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    return eq > 0 ? eq + 1 : null;
  }
  const letter = [...v.slice(1)].findIndex((c) => VALUE_OPTS.has(`-${c}`));
  return letter >= 0 && letter + 2 < v.length ? letter + 2 : null;
}

/** The first index of `value` whose text is only known at run time; 0 when that cannot be placed. */
function firstDynamic(word: WordToken): number {
  if (!word.dynamic) return 0;
  const at = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at)];
  return at.length > 0 ? Math.min(...at) : 0;
}

/**
 * An unquoted expansion may word-split into several words, flags and command words among them: an unknown value
 * always, a known one when it holds a blank (bash splits it, zsh does not).
 */
function maySplit(word: WordToken | undefined): boolean {
  if (word === undefined) return false;
  if (word.dynamic) return !word.quoted || word.unquotedExpansion === true;
  return word.unquotedExpansion === true && word.typed !== undefined && /\s/.test(word.value);
}
