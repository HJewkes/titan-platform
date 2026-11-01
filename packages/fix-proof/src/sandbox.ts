import { spawnSync } from "node:child_process";

/** The exec flag naming the sandbox user; fix-proof-run.sh greps every merge-base dist/*.js chunk for it to tell an old runner apart. */
export const SANDBOX_FLAG = "sandbox-user";
/** A plain login name, so the value can never read as an option or carry shell syntax into sudo's argv. */
export const SANDBOX_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
// After the budget, timeout sends TERM and then KILL this many seconds later to a command that ignores TERM.
const KILL_AFTER_S = 5;

/** Resolves a user's primary gid, or null when the account is unknown. */
export type GidLookup = (user: string) => string | null;

/** Asks the system's own `id`, because the primary group's name need not match the user's (Debian's nobody is in nogroup). */
export const systemGid: GidLookup = (user) => {
  const result = spawnSync("id", ["-g", "--", user], { encoding: "utf-8" });
  const gid = result.status === 0 ? result.stdout.trim() : "";
  return /^\d+$/.test(gid) ? gid : null;
};

export function assertSandboxUser(user: string): void {
  if (!SANDBOX_USER_PATTERN.test(user)) throw new Error(`sandbox user must match ${SANDBOX_USER_PATTERN.source}`);
}

/**
 * Argv running `sh -c <script> sh ...args` as user in a fresh PID namespace, with no_new_privs and an empty capability
 * bounding set. Every process the script starts dies with it, setsid or not, because the namespace's init does. The
 * root-owned timeout enforces the budget, since a runner-uid group kill cannot reach a root-owned unshare. The group is
 * the user's numeric primary gid, and an unresolvable user throws rather than run unsandboxed.
 */
export function sandboxCommand(
  user: string,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
  script: string,
  args: readonly string[],
  lookupGid: GidLookup = systemGid,
): { file: string; args: string[] } {
  assertSandboxUser(user);
  const gid = lookupGid(user);
  if (gid === null) throw new Error(`sandbox user ${user} has no resolvable primary gid`);
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return {
    file: "sudo",
    args: [
      "-n", "--", "timeout", "-k", String(KILL_AFTER_S), seconds,
      "unshare", "--pid", "--fork", "--kill-child", "--mount-proc", "--",
      "setpriv", "--reuid", user, "--regid", gid, "--init-groups", "--no-new-privs", "--bounding-set=-all", "--",
      "env", "-i", ...pairs, "sh", "-c", `${script} "$@"`, "sh", ...args,
    ],
  };
}

/**
 * The sandboxed run's whole environment. HOME is the tree, so a browser cache must be named explicitly, and only the
 * runner's own value is forwarded: the sandbox user cannot read the runner's home, so a guessed default would not help.
 */
export function sandboxEnv(tree: string, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { PATH: parent.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tree, CI: "1" };
  if (parent.PLAYWRIGHT_BROWSERS_PATH !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = parent.PLAYWRIGHT_BROWSERS_PATH;
  return env;
}
