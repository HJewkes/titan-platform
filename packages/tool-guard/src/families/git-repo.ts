import type { SimpleCommand } from "../shell/commands.js";
import { SOURCERS } from "../shell/sourced.js";
import { DECLARERS } from "../shell/vars.js";
import { declaresVar } from "./proxy-route.js";

/** `GIT_*` variables that change only how git talks to a person or a log, never which repository it opens. */
const HARMLESS_VAR =
  /^GIT_(?:TERMINAL_PROMPT|TRACE\w*|PAGER|EDITOR|SEQUENCE_EDITOR|AUTHOR_\w+|COMMITTER_\w+|ASKPASS|PROGRESS_DELAY|CURL_VERBOSE)$/;
/** The variables that, inherited by the hook's own process, relocate every git command the agent runs. */
const RELOCATING_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE"];
/** In the typed text, a prefix, plain or `${NAME:=…}` assignment of a `GIT_*` name, whatever its value. */
const TEXT_ASSIGNS_RE = /(?<![\w$])(GIT_\w*)(?:\[[^\]]*\])?\+?=|\$\{(GIT_\w*)(?:\[[^\]]*\])?:{0,2}=/g;
/** A declaration option that makes a nameref, through which a later write reaches the named variable. */
const NAMEREF_RE = /^-[a-zA-Z]*n/;
/** `set -a`, `set -o allexport` and zsh's `setopt allexport`/`all_export` export every later assignment. */
const ALLEXPORT_RE = /^(?:-[a-zA-Z]*a|all_?export)$/i;

/** Whether git may read `name` as a repository location or another setting the guard does not model. */
export function isRepoVar(name: string): boolean {
  return name.startsWith("GIT_") && !HARMLESS_VAR.test(name);
}

/** Whether the hook's own environment already relocates the repository every git command opens. */
export function inheritsRepoVar(env: NodeJS.ProcessEnv): boolean {
  return RELOCATING_VARS.some((name) => env[name] !== undefined);
}

/**
 * Whether the line may run git in a repository other than the one its directory holds: it assigns a `GIT_*` name
 * git reads, exports or declares one, may export every assignment, or sources a file that may do either.
 * Emission order is not run order, so this holds for every git command on the line.
 */
export function relocatesRepo(src: string, commands: SimpleCommand[]): boolean {
  if ([...src.matchAll(TEXT_ASSIGNS_RE)].some((m) => isRepoVar(m[1] ?? m[2] ?? ""))) return true;
  return commands.some(commandRelocates);
}

function commandRelocates(cmd: SimpleCommand): boolean {
  if (Object.keys(cmd.env).some(isRepoVar)) return true;
  if (cmd.name === null) return false;
  if (SOURCERS.has(cmd.name)) return true;
  if (cmd.name === "set" || cmd.name === "setopt") return cmd.args.some((a) => a.dynamic || ALLEXPORT_RE.test(a.value));
  if (!DECLARERS.has(cmd.name)) return false;
  return declaresVar(cmd, isRepoVar) || cmd.args.some((a) => NAMEREF_RE.test(a.value));
}
