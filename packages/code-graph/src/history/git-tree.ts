import { execFileSync } from "node:child_process";
import { discoveryEnv, runGit, runGitLarge } from "./git.js";

/** A regular file in a commit's tree: its repo-relative path and blob id. */
export interface TreeBlob {
  path: string;
  oid: string;
}

export interface ResolvedCommit {
  commit: string;
  /** Committer time, seconds since the epoch. */
  commitEpoch: number;
}

const TREE_LIST_BUFFER = 256 * 1024 * 1024;
const BLOB_READ_BUFFER = 1024 * 1024 * 1024;
// Symlinks (120000) and submodules (160000) are not files a working-tree walk ingests.
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** Resolve `rev` to a commit sha and its committer epoch; throws naming `rev` when it is not a commit. */
export function resolveCommit(repoRoot: string, rev: string): ResolvedCommit {
  const commit = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!commit) throw new Error(`Unknown git revision "${rev}": it does not name a commit in ${repoRoot}`);
  const epoch = Number(runGit(repoRoot, ["show", "-s", "--format=%ct", commit]));
  if (!Number.isFinite(epoch)) throw new Error(`Could not read the commit time of ${commit} in ${repoRoot}`);
  return { commit, commitEpoch: epoch };
}

/** Every regular file in `commit`'s tree, via `git ls-tree -r -z`. */
export function listTreeBlobs(repoRoot: string, commit: string): TreeBlob[] {
  const out = runGitLarge(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", commit], TREE_LIST_BUFFER);
  if (out === null) throw new Error(`git ls-tree failed for ${commit} in ${repoRoot}`);
  return parseLsTree(out);
}

/** Parse NUL-terminated `<mode> <type> <oid>\t<path>` records, keeping regular files only. */
export function parseLsTree(text: string): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const record of text.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type === "blob" && oid && REGULAR_FILE_MODES.has(mode!)) blobs.push({ path: record.slice(tab + 1), oid });
  }
  return blobs;
}

/** UTF-8 content of each blob in `oids`, read with a single `git cat-file --batch`. */
export function readBlobs(repoRoot: string, oids: readonly string[]): Map<string, string> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Map();
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: unique.map((oid) => `${oid}\n`).join(""),
    maxBuffer: BLOB_READ_BUFFER,
    stdio: ["pipe", "pipe", "ignore"],
    env: discoveryEnv(),
  });
  return parseCatFileBatch(out);
}

/** Parse `<oid> <type> <size>\n<bytes>\n` records; sizes are byte counts, so this walks a Buffer. */
export function parseCatFileBatch(out: Buffer): Map<string, string> {
  const blobs = new Map<string, string>();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const [oid, type, size] = out.toString("utf-8", at, eol).split(" ");
    if (type === "missing" || size === undefined) throw new Error(`git object ${oid} is missing`);
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(oid!, out.toString("utf-8", start, end));
    at = end + 1;
  }
  return blobs;
}
