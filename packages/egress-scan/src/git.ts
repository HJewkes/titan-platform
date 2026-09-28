import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { ConfigError } from "./config.js";
import { parseCommit, parseDiff, type ScanSource } from "./diff.js";

/** A git command that failed. The message names the subcommand, never git's output. */
export class GitError extends Error {
  constructor(subcommand: string, status: number | null) {
    super(`git ${subcommand} failed (exit ${status ?? "signal"}); run it by hand to see git's error`);
    this.name = "GitError";
  }
}

export interface PushUpdate {
  readonly localSha: string;
  readonly remoteSha: string;
}

// Pinned so user config (prefixes, textconv, relative, external diff) cannot reshape the patch text.
const PATCH_FLAGS = [
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];
const MAX_BUFFER = 1024 * 1024 * 1024;
// Every revision argument follows this, so a value that starts with a dash cannot become an option.
const END_OF_OPTIONS = "--end-of-options";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVISION = /^(?:[0-9a-f]{7,64}|[^-\s]\S*)$/;
const REMOTE_NAME = /^[^-\s]\S*$/;

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/** A hex sha of 7 to 64 characters, or a ref name that cannot be read as an option. */
export function isRevision(value: string): boolean {
  return REVISION.test(value);
}

export function isRemoteName(value: string): boolean {
  return REMOTE_NAME.test(value);
}

function requireRevision(value: string, what: string): void {
  if (!isRevision(value)) throw new ConfigError(`${what} is not a sha or ref name`);
}

export function git(cwd: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf-8", maxBuffer: MAX_BUFFER });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new GitError(args[0] ?? "", result.status);
  return result.stdout;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** Resolves the hooks directory as git does: `core.hooksPath` if set, else the common git dir's hooks. */
export function hooksDir(cwd: string): string {
  return path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "hooks"]).trim());
}

/** Parses git's pre-push stdin: `<local-ref> <local-sha> <remote-ref> <remote-sha>` per line. */
export function parsePrePush(stdin: string): PushUpdate[] {
  return lines(stdin).map((line, i) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new ConfigError(`pre-push stdin line ${i + 1}: expected four fields`);
    for (const field of [1, 3]) {
      if (!isFullSha(fields[field] ?? "")) {
        throw new ConfigError(`pre-push stdin line ${i + 1}: field ${field + 1} is not a full sha`);
      }
    }
    return { localSha: fields[1] ?? "", remoteSha: fields[3] ?? "" };
  });
}

function hasCommit(cwd: string, sha: string): boolean {
  return spawnSync("git", ["cat-file", "-e", END_OF_OPTIONS, `${sha}^{commit}`], { cwd }).status === 0;
}

/** The commits one pushed ref update sends that the remote lacks, oldest first. */
export function commitsForUpdate(cwd: string, remote: string, update: PushUpdate): string[] {
  if (isZeroSha(update.localSha)) return [];
  if (!isFullSha(update.localSha) || !isFullSha(update.remoteSha)) throw new ConfigError("push update is not a full sha");
  if (!isRemoteName(remote)) throw new ConfigError("remote is not a remote name");
  const known = !isZeroSha(update.remoteSha) && hasCommit(cwd, update.remoteSha);
  // The second `--not` flips back, so the local sha after it counts as included.
  const range = known
    ? [END_OF_OPTIONS, `${update.remoteSha}..${update.localSha}`]
    : ["--not", `--remotes=${remote}`, "--not", END_OF_OPTIONS, update.localSha];
  return lines(git(cwd, ["rev-list", "--reverse", ...range]));
}

/** The commits in `base..head`, oldest first; an all-zero base means `head` alone. */
export function commitsForRange(cwd: string, base: string, head: string): string[] {
  requireRevision(base, "range base");
  requireRevision(head, "range head");
  if (isZeroSha(base)) return lines(git(cwd, ["rev-list", "--no-walk", END_OF_OPTIONS, head]));
  return lines(git(cwd, ["rev-list", "--reverse", END_OF_OPTIONS, `${base}..${head}`]));
}

/** One commit's message and patch; `-c` makes a merge show the lines it brings in from any parent. */
export function readCommit(cwd: string, sha: string): ScanSource {
  requireRevision(sha, "commit");
  return parseCommit(sha, git(cwd, ["show", "-c", ...PATCH_FLAGS, "--format=%B%x00", END_OF_OPTIONS, sha]));
}

/** Every tracked file at HEAD, as one diff from the empty tree. */
export function readTree(cwd: string): ScanSource {
  const emptyTree = git(cwd, ["hash-object", "-t", "tree", "--stdin"], "").trim();
  return parseDiff(git(cwd, ["diff", ...PATCH_FLAGS, "--no-renames", END_OF_OPTIONS, emptyTree, "HEAD"]));
}
