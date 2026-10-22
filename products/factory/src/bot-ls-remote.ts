import { LsRemoteError, execGit, lsRemoteBranchHead, lsRemotePullHead, type GitExec } from "@titan-design/github";
import type { Unavailable } from "./head-guard/guard.js";
import type { RemoteRef } from "./reconciler/guard-verdicts.js";

/** TP-3097's `git ls-remote` second opinion, sent as the bot; a failed read is unavailable, never a sha. */
export type BotLsRemote = (repo: string, ref: RemoteRef) => Promise<string | null | Unavailable>;

const UNAVAILABLE: Unavailable = { kind: "unavailable" };

export function botLsRemote(token: string, exec: GitExec = execGit): BotLsRemote {
  const env = botGitEnv(token);
  return async (repo, ref) => {
    const url = `https://github.com/${repo}.git`;
    try {
      return "pr" in ref ? await lsRemotePullHead(exec, url, ref.pr, { env }) : await lsRemoteBranchHead(exec, url, ref.branch, { env });
    } catch (error) {
      if (error instanceof LsRemoteError) return UNAVAILABLE;
      throw error;
    }
  };
}

/**
 * The child env is merged over serve's own, which is the user login's. So every place git could find that login's
 * credential is shut: no global, system or `-c` config, no credential helper, no askpass, and https only, so no
 * `insteadOf` can turn the read into an ssh one that uses the user's key. The bot's header is then the only credential.
 */
export function botGitEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_PARAMETERS: "",
    GIT_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}
