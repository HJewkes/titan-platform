import fs from "node:fs";
import path from "node:path";

import {
  CFG_FN,
  CLUSTER_FN,
  DEFAULT_REMOTE_FN,
  DESTINATIONS_FN,
  EXPAND_FN,
  HOOKS_CHECK,
  IS_LOCAL_FN,
  LOCAL_ONLY_FN,
  PUSH_REPOS_FN,
  SUBMODULES_OFF_FN,
  VALUES_FN,
} from "./git-shim-local.js";
import { EXT_CHECK, HIDE_GIT_CONFIG, PIN_MIRROR, PIN_PROTOCOLS, RESTORE_GIT_CONFIG, shQuote } from "./git-shim-pin.js";
import {
  ARGS_PUSH_FN,
  AUTOCORRECT_FN,
  EXTERNAL_FN,
  FOREIGN_EXEC_PATH_FN,
  MENTIONS_PUSH_FN,
  QUOTE_FN,
  REFUSE_ALIAS_FN,
  REFUSE_EXT_FN,
  REFUSE_FN,
  RESOLVE_FN,
  SHADOWED_FN,
  SPLIT_FN,
  TYPO_FN,
} from "./git-shim-resolve.js";
import { probeGit, writeGitMirror } from "./git-mirror.js";
import { ENVIRONMENT_SCRUB, hardenedShebang, posixShell } from "./posix-shell.js";
import { isAgentChatShim, SHIM_HEADER } from "./shim-header.js";

/** git's rule for a config variable name, so any other word cannot be an alias. */
export const ALIAS_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Names the dir holding the agent's `git` shim in the launch plan; `run-agent` puts it first on PATH. */
export const GIT_SHIM_DIR_ENV = "AGENT_CHAT_GIT_SHIM_DIR";

/** `<home>/git-bin`, beside the guard's `<home>/git-hooks`, so the pure plan builder needs no extra input. */
export const gitShimDirFor = (hooksDir: string): string => path.join(path.dirname(hooksDir), "git-bin");

/** Only names an alias can have, lowercased, so a listed name can never inject shell into the shim. */
const bakedShellAliases = (names: readonly string[]): string =>
  names
    .filter((name) => ALIAS_NAME.test(name))
    .map((name) => name.toLowerCase())
    .join(" ");

/** The config-file locations the agent starts with, baked so one call cannot swap them. */
export interface SpawnConfigHome {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
}

// Every shell function the shim defines, in the order a later one may call an earlier one.
const SHIM_FUNCTIONS = [
  QUOTE_FN,
  REFUSE_FN,
  REFUSE_ALIAS_FN,
  REFUSE_EXT_FN,
  SPLIT_FN,
  AUTOCORRECT_FN,
  TYPO_FN,
  EXTERNAL_FN,
  MENTIONS_PUSH_FN,
  ARGS_PUSH_FN,
  SHADOWED_FN,
  FOREIGN_EXEC_PATH_FN,
  RESOLVE_FN,
  CFG_FN,
  VALUES_FN,
  IS_LOCAL_FN,
  EXPAND_FN,
  DESTINATIONS_FN,
  DEFAULT_REMOTE_FN,
  CLUSTER_FN,
  PUSH_REPOS_FN,
  SUBMODULES_OFF_FN,
  LOCAL_ONLY_FN,
].join("\n");

const bakedValues = (
  real: string,
  guard: string,
  builtins: readonly string[],
  execPath: string,
  shellAliases: readonly string[],
  spawnHome: SpawnConfigHome,
): string =>
  `real=${shQuote(real)}
guard=${shQuote(guard)}
exec_path=${shQuote(execPath)}
builtins=${shQuote(builtins.join(" "))}
[ -n "$builtins" ] || builtins=$("$real" --list-cmds=builtins 2>/dev/null | LC_ALL=C tr '\\n' ' ')
shell_aliases=${shQuote(bakedShellAliases(shellAliases))}
spawn_home=${shQuote(spawnHome.HOME ?? "")}
spawn_xdg=${shQuote(spawnHome.XDG_CONFIG_HOME ?? "")}`;

/**
 * The agent's `git`: a push, found after global options or through `alias.<word>`, is refused when
 * it skips verification or when the hooks path git resolves is not the guard's. A shell (`!`)
 * alias runs only when its name is in `shellAliases` (CC-613). Everything else execs the real
 * git, baked as an absolute path so the shim never finds itself.
 */
export const gitShimScript = (
  real: string,
  guard: string,
  builtins: readonly string[],
  execPath = "",
  shell = posixShell(),
  shellAliases: readonly string[] = [],
  spawnHome: SpawnConfigHome = {},
  mirror = "",
): string =>
  `${hardenedShebang(shell)}
${SHIM_HEADER} at each spawn (TP-596); local edits are overwritten.
${ENVIRONMENT_SCRUB}mirror=${shQuote(mirror)}
${PIN_MIRROR}
${HIDE_GIT_CONFIG}
${PIN_PROTOCOLS}
${bakedValues(real, guard, builtins, execPath, shellAliases, spawnHome)}
${SHIM_FUNCTIONS}
if resolve "$@"; then
${HOOKS_CHECK}
fi
${EXT_CHECK}
${RESTORE_GIT_CONFIG}
exec "$real" "$@"
`;

export const realpathOr = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

export const isExecutableFile = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The first `git` on PATH that is not an agent-chat shim, this one or any other (CC-1653: another
 * shim baked as the real git runs its own guard's checks against this shim's hooks dir). Kept
 * unresolved so a package upgrade does not strand it.
 */
export function findRealGit(pathValue: string, shimDir: string): string | undefined {
  const shim = realpathOr(path.join(shimDir, "git"));
  const ownDir = realpathOr(shimDir);
  for (const dir of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(dir) || realpathOr(dir) === ownDir) continue;
    const candidate = path.join(dir, "git");
    if (isExecutableFile(candidate) && realpathOr(candidate) !== shim && !isAgentChatShim(candidate)) return candidate;
  }
  return undefined;
}

/** Read with GIT_EXEC_PATH unset, so it stays the real core under a nested launch; empty on failure. */
const gitExecPath = (real: string): string => {
  try {
    return probeGit(real, ["--exec-path"]).trim();
  } catch {
    return "";
  }
};

/** Empty on failure; the shim then reads the list itself on each call, and `push` is matched by name first. */
function gitBuiltins(real: string): string[] {
  try {
    return probeGit(real, ["--list-cmds=builtins"])
      .split("\n")
      .filter((name) => /^[a-z0-9-]+$/.test(name));
  } catch {
    return [];
  }
}

/** Rewritten through a rename, so a git call at that moment never execs a half-written file. */
export function writeGitShim(
  dir: string,
  guard: string,
  pathValue: string = process.env.PATH ?? "",
  shellAliases: readonly string[] = [],
  spawnHome: SpawnConfigHome = process.env,
): boolean {
  const real = findRealGit(pathValue, dir);
  if (real === undefined) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const builtins = gitBuiltins(real);
  const execPath = gitExecPath(real);
  const mirror = writeGitMirror(dir, real, execPath, builtins);
  const target = path.join(dir, "git");
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, gitShimScript(real, guard, builtins, execPath, posixShell(), shellAliases, spawnHome, mirror), { mode: 0o755 });
  fs.chmodSync(temp, 0o755);
  fs.renameSync(temp, target);
  return true;
}
