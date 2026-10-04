import type { SimpleCommand } from "../shell/commands.js";
import { parseGit } from "../shell/git.js";
import type { GitInvocation } from "../shell/git.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";
import { merge } from "./merge.js";
import { hasFlag, readOptions, set } from "./options.js";
import { release } from "./release.js";

export type PreferenceId = "R86" | "R50" | "R31" | "R127" | "R133" | "R64" | "R164";

/** What a row needs that the command text does not carry. */
export interface PreferenceContext {
  /** Whether the session is a seat, where every merge goes through `seat-merge`. */
  seat: boolean;
}

export interface PreferenceHit {
  id: PreferenceId;
  /** One sentence telling the agent what to do instead. */
  message: string;
}

interface PreferenceRow {
  id: PreferenceId;
  message: string;
  matches(commands: SimpleCommand[], ctx: PreferenceContext): boolean;
}

/** No filesystem behind it: the checker stays pure, so a head that needs reading stays unread. */
const NO_FS: ClassifyContext = { home: "", readLink: () => null, readHead: () => null, readScript: () => null };
/** Spellings that turn on the checked-out branch, which a pure checker cannot read. */
const HEAD_DEPENDENT = set("bash.merge.git-merge-protected", "bash.merge.git-push-implicit");
const PUBLISHES = set("bash.release.npm-publish", "bash.release.pnpm-publish", "bash.release.yarn-bun-publish", "bash.release.changeset-publish");

/** The merge and release actions a command takes, as those families classify them. */
function guarded(cmd: SimpleCommand): ClassifiedAction[] {
  const families = [merge, release].filter((f) => cmd.name !== null && f.names?.has(cmd.name));
  return families.flatMap((f) => f.bash?.(cmd, NO_FS) ?? []).filter((a) => !HEAD_DEPENDENT.has(a.spelling));
}

const isMerge = (a: ClassifiedAction) => a.action === "merge" || a.spelling === "bash.release.version-packages-merge";

const PROCESS_VALUES = set("-P", "-g", "-G", "-s", "-t", "-u", "-U", "-F", "--signal");

/** `pgrep`, `pkill`: scoped to the children of a known pid with `-P`, otherwise matched by name. */
const byParentPid = (cmd: SimpleCommand) => hasFlag(readOptions(cmd.args, PROCESS_VALUES), "-P");

function killsByName(commands: SimpleCommand[]): boolean {
  const direct = commands.some((c) => c.name === "killall" || (c.name === "pkill" && !byParentPid(c)));
  const looked = commands.some((c) => c.name === "pidof" || (c.name === "pgrep" && !byParentPid(c)));
  return direct || (looked && commands.some((c) => c.name === "kill"));
}

const publishes = (cmd: SimpleCommand) =>
  !cmd.args.some((a) => a.value === "--dry-run") && guarded(cmd).some((a) => PUBLISHES.has(a.spelling));

const SHELLS = set("sh", "bash", "zsh", "dash", "ksh");

/** A command that only runs the shell text inside it, which `extractCommands` also lists. */
function wrapsText(cmd: SimpleCommand): boolean {
  if (cmd.name === "eval" || cmd.name === "watch") return true;
  return cmd.name !== null && SHELLS.has(cmd.name) && (cmd.args.length === 0 || cmd.args.some((a) => /^-[a-z]*c[a-z]*$/.test(a.value)));
}

const git = (cmd: SimpleCommand): GitInvocation | null => (cmd.name === "git" ? parseGit(cmd.args, cmd.dir) : null);
const GIT_BRANCH_VALUES = set("-u", "--set-upstream-to", "--format", "--sort", "--contains", "--merged", "--points-at");
const GIT_PUSH_VALUES = set("-o", "--push-option", "--repo", "--receive-pack", "--exec");

function deletesBranchOrPushesTag(inv: GitInvocation): boolean {
  if (inv.sub === "branch") return hasFlag(readOptions(inv.subArgs, GIT_BRANCH_VALUES), "-d", "-D", "--delete");
  if (inv.sub !== "push") return false;
  const options = readOptions(inv.subArgs, GIT_PUSH_VALUES);
  if (hasFlag(options, "-d", "--delete", "--tags", "--follow-tags")) return true;
  return options.positionals.slice(1).some((s) => s.value.startsWith(":") || s.value.includes("refs/tags/"));
}

/** A merge, release, deploy, branch delete or tag push: each must be the only command in its call. */
function ownCall(cmd: SimpleCommand): boolean {
  const inv = git(cmd);
  return guarded(cmd).length > 0 || (inv !== null && deletesBranchOrPushesTag(inv));
}

function chainsOwnCall(commands: SimpleCommand[]): boolean {
  const run = commands.filter((c) => !wrapsText(c));
  return run.length > 1 && run.some(ownCall);
}

const GH_VALUES = set("-R", "--repo", "--json", "-q", "--jq", "-t", "--template", "-i", "--interval", "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field");
const CI_API_RE = /\/(?:check-runs|check-suites|status|actions\/runs)\b/;

function ghWords(cmd: SimpleCommand): { words: string[]; watch: boolean } | null {
  if (cmd.name !== "gh") return null;
  const options = readOptions(cmd.args, GH_VALUES);
  return { words: options.positionals.map((w) => w.value), watch: hasFlag(options, "--watch") };
}

function watchesCi(cmd: SimpleCommand): boolean {
  const gh = ghWords(cmd);
  const [group, verb] = gh?.words ?? [];
  return (group === "run" && verb === "watch") || (group === "pr" && verb === "checks" && gh?.watch === true);
}

function readsCi(cmd: SimpleCommand): boolean {
  const [group, verb] = ghWords(cmd)?.words ?? [];
  if (group === "api") return verb !== undefined && CI_API_RE.test(verb);
  if (group === "run") return verb === "list" || verb === "view";
  return group === "pr" && (verb === "checks" || verb === "view");
}

/** Shell loop keywords never reach the command list, so a sleep or `watch` beside a CI read stands for the loop. */
function pollsCi(commands: SimpleCommand[]): boolean {
  if (commands.some(watchesCi)) return true;
  return commands.some((c) => c.name === "sleep" || c.name === "watch") && commands.some(readsCi);
}

const testsLiveRoot = (cmd: SimpleCommand) =>
  cmd.name === "active-work" && Object.hasOwn(cmd.env, "XDG_DATA_HOME") && !Object.hasOwn(cmd.env, "ACTIVE_ROOT");

/** Per subcommand, the options that take a value, so a message such as `-m "--no-verify"` is not read as the flag. */
const GIT_VALUES: Record<string, ReadonlySet<string>> = {
  commit: set("-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "-t", "--template", "--author", "--date", "--trailer", "--fixup", "--squash", "--cleanup"),
  push: GIT_PUSH_VALUES,
  merge: set("-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option"),
};

function skipsHooks(cmd: SimpleCommand): boolean {
  const inv = git(cmd);
  if (!inv?.sub) return false;
  if (inv.config.some((c) => /^core\.hookspath=/i.test(c))) return true;
  const options = readOptions(inv.subArgs, GIT_VALUES[inv.sub] ?? set());
  return hasFlag(options, "--no-verify") || (inv.sub === "commit" && hasFlag(options, "-n"));
}

/** The preference rows, in report order. Each matcher reads only the parsed commands and `ctx`. */
export const PREFERENCES: readonly PreferenceRow[] = [
  {
    id: "R86",
    message: "Kill only a process you started, by the PID you recorded, never by name, because other sessions run servers on this machine.",
    matches: killsByName,
  },
  {
    id: "R50",
    message: "Do not publish from a session: releases publish from CI, and a first publish is the owner's `pnpm publish --access public --no-git-checks`, so queue that command for the owner.",
    matches: (commands) => commands.some(publishes),
  },
  {
    id: "R31",
    message: "Run the merge, branch delete, deploy or tag push as its own Bash call, and run everything else in later calls.",
    matches: chainsOwnCall,
  },
  {
    id: "R127",
    message: "Do not poll CI; run `ci-wait <owner/repo> <sha>` in the foreground, which exits 0 on green, 1 on red with the failing jobs and 2 on a timeout.",
    matches: pollsCi,
  },
  {
    id: "R133",
    message: "Merge with `seat-merge <seat> <owner/repo> <pr> <head sha> <clone>`, which checks the verdict, the checks and the merge tree first.",
    matches: (commands, ctx) => ctx.seat && commands.some((c) => guarded(c).some(isMerge)),
  },
  {
    id: "R64",
    message: "`XDG_DATA_HOME` does nothing on macOS, so this command would hit the live active-work root; set `ACTIVE_ROOT=<temp dir>` instead.",
    matches: (commands) => commands.some(testsLiveRoot),
  },
  {
    id: "R164",
    message: "Do not skip hooks; fix what the hook reported, then commit or push again.",
    matches: (commands) => commands.some(skipsHooks),
  },
];

/** The preference rows a parsed command list breaks. Pure: no filesystem, environment or clock. */
export function checkPreferences(commands: SimpleCommand[], ctx: PreferenceContext): PreferenceHit[] {
  return PREFERENCES.filter((row) => row.matches(commands, ctx)).map(({ id, message }) => ({ id, message }));
}
