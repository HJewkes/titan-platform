import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as path from "node:path";
import { ConfigError } from "./config.js";
import { parseDiff, type IdentField, type ScanSource } from "./diff.js";

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

/** One pre-push stdin line: the shas plus the local and remote ref names, which leave the machine too. */
export interface PushLine extends PushUpdate {
  readonly localRef: string;
  readonly remoteRef: string;
}

/** A commit or tree whose patch text passes this many bytes is refused: over it, V8 cannot hold the text as one string. */
export const MAX_PATCH_BYTES = 128 * 1024 * 1024;

/** A commit or tree too large to scan. The message names the source and the limit, never the content. */
export class PatchTooLargeError extends Error {
  constructor(sha: string | undefined, limit: number) {
    super(`${sha === undefined ? "tree" : `commit ${sha.slice(0, 7)}`}: patch text is over the scan limit of ${formatBytes(limit)}; refusing it`);
    this.name = "PatchTooLargeError";
  }
}

export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib} MiB` : `${bytes} bytes`;
}

// Pinned so user config (prefixes, textconv, relative, external diff) cannot reshape the patch text.
// `--text` diffs a file git calls binary, so one NUL byte cannot hide the lines around it.
const PATCH_FLAGS = [
  "--text",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];
// A message re-encoded by `i18n.logOutputEncoding` (UTF-16, say) would slip past every rule.
// The raw `%an` forms, not the mailmapped `%aN`, since the raw ident is what the push sends.
const MESSAGE_FLAGS = ["--no-patch", "--encoding=UTF-8", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B"];
const IDENT_FIELDS = ["author.name", "author.email", "committer.name", "committer.email"];
// A combined diff ignores `--text`, so a merge is diffed against each parent in turn instead.
const COMMIT_PATCH_FLAGS = ["--diff-merges=separate", "--format=", ...PATCH_FLAGS];
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

function runGit(cwd: string, args: readonly string[], maxBuffer: number, input?: string): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, input, encoding: "utf-8", maxBuffer });
}

function stdoutOf(result: SpawnSyncReturns<string>, subcommand: string): string {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new GitError(subcommand, result.status);
  return result.stdout;
}

export function git(cwd: string, args: readonly string[], input?: string): string {
  return stdoutOf(runGit(cwd, args, MAX_BUFFER, input), args[0] ?? "");
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
export function parsePrePush(stdin: string): PushLine[] {
  return lines(stdin).map((line, i) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new ConfigError(`pre-push stdin line ${i + 1}: expected four fields`);
    for (const field of [1, 3]) {
      if (!isFullSha(fields[field] ?? "")) {
        throw new ConfigError(`pre-push stdin line ${i + 1}: field ${field + 1} is not a full sha`);
      }
    }
    return { localRef: fields[0] ?? "", localSha: fields[1] ?? "", remoteRef: fields[2] ?? "", remoteSha: fields[3] ?? "" };
  });
}

/** The ref names a push sends, as idents named `push line <n> local ref` and `remote ref`; deletions are skipped. */
export function refSource(pushLines: readonly PushLine[]): ScanSource {
  const idents = pushLines.flatMap((line, i): IdentField[] =>
    isZeroSha(line.localSha)
      ? []
      : [
          { field: `push line ${i + 1} local ref`, text: line.localRef },
          { field: `push line ${i + 1} remote ref`, text: line.remoteRef },
        ],
  );
  return { files: [], binaryFiles: 0, idents };
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
  // A branch that merged main also carries main commits the remote already has, so its remote refs
  // are excluded as well as its own old tip. The second `--not` flips back, so the local sha after it counts as included.
  const excluded = known ? [update.remoteSha, `--remotes=${remote}`] : [`--remotes=${remote}`];
  const range = ["--not", ...excluded, "--not", END_OF_OPTIONS, update.localSha];
  return lines(git(cwd, ["rev-list", "--reverse", ...range]));
}

/** The commits in `base..head`, oldest first; an all-zero base means `head` alone. */
export function commitsForRange(cwd: string, base: string, head: string): string[] {
  requireRevision(base, "range base");
  requireRevision(head, "range head");
  if (isZeroSha(base)) return lines(git(cwd, ["rev-list", "--no-walk", END_OF_OPTIONS, head]));
  return lines(git(cwd, ["rev-list", "--reverse", END_OF_OPTIONS, `${base}..${head}`]));
}

function isOverBuffer(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
}

/** Refuses a source in which git still skipped a file as binary, since its lines went unscanned. */
function requireAllText(source: ScanSource, what: string): ScanSource {
  if (source.binaryFiles > 0) throw new Error(`${what}: git printed a file as binary despite --text; refusing it`);
  return source;
}

function showCommit(cwd: string, sha: string, flags: readonly string[], maxBytes: number): string {
  const result = runGit(cwd, ["show", ...flags, END_OF_OPTIONS, sha], maxBytes);
  if (isOverBuffer(result.error)) throw new PatchTooLargeError(sha, maxBytes);
  return stdoutOf(result, "show");
}

function splitHeader(text: string): { idents: IdentField[]; message: string[] } {
  const parts = text.split("\0");
  const idents = IDENT_FIELDS.map((field, i) => ({ field, text: parts[i] ?? "" }));
  // A NUL inside the message itself stays in the message rather than shifting the fields.
  const message = parts.slice(IDENT_FIELDS.length).join("\0").replace(/\n+$/, "").split("\n");
  return { idents, message };
}

/**
 * One commit's idents, message and patch, read by separate calls so a merge's per-parent copies of
 * the message never land inside its patch. Throws `PatchTooLargeError` when either is over `maxPatchBytes`.
 */
export function readCommit(cwd: string, sha: string, maxPatchBytes = MAX_PATCH_BYTES): ScanSource {
  requireRevision(sha, "commit");
  const { idents, message } = splitHeader(showCommit(cwd, sha, MESSAGE_FLAGS, maxPatchBytes));
  const patch = parseDiff(showCommit(cwd, sha, COMMIT_PATCH_FLAGS, maxPatchBytes));
  return requireAllText({ ...patch, sha, message, idents }, `commit ${sha.slice(0, 7)}`);
}

/** Every tracked file at HEAD, as one diff from the empty tree. Throws `PatchTooLargeError` over `maxPatchBytes`. */
export function readTree(cwd: string, maxPatchBytes = MAX_PATCH_BYTES): ScanSource {
  const emptyTree = git(cwd, ["hash-object", "-t", "tree", "--stdin"], "").trim();
  const args = ["diff", ...PATCH_FLAGS, "--no-renames", END_OF_OPTIONS, emptyTree, "HEAD"];
  const result = runGit(cwd, args, maxPatchBytes);
  if (isOverBuffer(result.error)) throw new PatchTooLargeError(undefined, maxPatchBytes);
  return requireAllText(parseDiff(stdoutOf(result, "diff")), "tree");
}
