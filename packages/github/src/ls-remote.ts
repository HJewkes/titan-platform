import type { GitExec } from "./exec.js";
import { redact } from "./redact.js";
import { GitHubInputError, checkPositiveInt } from "./validate.js";

export interface LsRemoteOptions {
  /**
   * The credential for this one call, such as `GIT_ASKPASS` or `GIT_CONFIG_*` entries carrying an `http.extraHeader`.
   * It rides in the child env only; its values and anything shaped like a GitHub token are cut from every error.
   */
  env?: Readonly<Record<string, string>>;
  /** Defaults to 30 s, so an unreachable remote fails the read rather than hang the caller. */
  timeoutMs?: number;
}

/** The read itself failed (git could not run, exited non-zero or printed something unparseable); it says nothing about the head. */
export class LsRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LsRemoteError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REMOTE_PROTOCOLS = new Set(["https:", "file:"]);

/**
 * The sha `refs/pull/<n>/head` points at on `remoteUrl`, read from git's own transport rather than the REST API, so it
 * is an independent second source for a head. Null when the remote has no such ref; a failed read throws `LsRemoteError`.
 */
export async function lsRemotePullHead(exec: GitExec, remoteUrl: string, n: number, options: LsRemoteOptions = {}): Promise<string | null> {
  const ref = `refs/pull/${checkPositiveInt("n", n)}/head`;
  const args = ["ls-remote", "--", checkRemoteUrl(remoteUrl), ref];
  const secrets = Object.values(options.env ?? {});
  const env = { ...options.env, GIT_TERMINAL_PROMPT: "0" };
  let result;
  try {
    result = await exec(args, { env, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (error) {
    throw new LsRemoteError(redact(`git ls-remote ${ref} failed: ${error instanceof Error ? error.message : String(error)}`, secrets));
  }
  if (result.code !== 0) throw new LsRemoteError(redact(`git ls-remote ${ref} exited ${result.code}: ${result.stderr.trim()}`, secrets));
  return pullHeadOf(result.stdout, ref);
}

/** A credential in the URL would put the token on argv, where any process listing can read it. */
function checkRemoteUrl(remoteUrl: string): string {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new GitHubInputError("remoteUrl", redact(remoteUrl, []), "expected an absolute https: or file: URL");
  }
  if (!REMOTE_PROTOCOLS.has(url.protocol)) throw new GitHubInputError("remoteUrl", url.protocol, "expected an https: or file: URL");
  if (url.username !== "" || url.password !== "") throw new GitHubInputError("remoteUrl", "[redacted]", "a credential belongs in options.env, never in the URL");
  return url.href;
}

/** git matches a pattern against the tail of each ref name, so only an exact name counts. */
function pullHeadOf(stdout: string, ref: string): string | null {
  const rows = stdout.split("\n").filter((line) => line !== "").map((line) => line.split("\t"));
  const matches = rows.filter(([, name]) => name === ref);
  if (matches.length === 0) return null;
  const sha = matches[0]![0]!;
  if (matches.length > 1 || !OID.test(sha)) throw new LsRemoteError(`git ls-remote ${ref} printed an unreadable answer`);
  return sha;
}
