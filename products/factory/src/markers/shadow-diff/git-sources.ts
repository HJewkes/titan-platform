import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DIFF_HASH_ARGS, DiffHashError, HARDENED_GIT_ENV, execGit, gitDiffPin, gitMergeUpCheck, serialiseDiff, type DiffPin, type GitExec, type MergeUpProof } from "@titan-design/github";
import type { PrKey } from "../../head-guard/epoch-store.js";
import type { PinSources } from "../pins.js";
import type { PinProbe } from "./pin-cause.js";

/** The bare mirror the shadow's git reads run in, by repo slug. */
type MirrorOf = (repo: string) => Promise<string>;

interface GitSourceOptions {
  exec?: GitExec;
  /** The fetch's credential; it rides over `HARDENED_GIT_ENV` for fetches alone, as in `gitDiffPin`. */
  fetchEnv?: Readonly<Record<string, string>>;
  now?: () => number;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const PIN_CACHE_MS = 60_000;

/**
 * One bare clone per repo under `<stateDir>/marker-git`, made on first use from the seat clone's `origin` URL (O6). The
 * seat clone is only read: `gitDiffPin` fetches `main` on every call, which in a seat clone races agents' own git.
 */
export function markerMirrors(stateDir: string, seatClone: (repo: string) => string | undefined, { exec = execGit, fetchEnv }: GitSourceOptions = {}): MirrorOf {
  const made = new Map<string, Promise<string>>();
  return (repo) => {
    const key = repo.toLowerCase();
    const pending = made.get(key) ?? makeMirror(exec, stateDir, repo, seatClone, fetchEnv);
    made.set(key, pending);
    pending.catch(() => made.delete(key));
    return pending;
  };
}

async function makeMirror(exec: GitExec, stateDir: string, repo: string, seatClone: (repo: string) => string | undefined, fetchEnv: GitSourceOptions["fetchEnv"]): Promise<string> {
  const slug = SLUG.exec(repo);
  if (slug === null || slug.slice(1).some((part) => part.startsWith("."))) throw new DiffHashError(`not a repo slug: ${JSON.stringify(repo.slice(0, 80))}`);
  const mirror = join(stateDir, "marker-git", `${slug[1]!.toLowerCase()}__${slug[2]!.toLowerCase()}.git`);
  if (existsSync(join(mirror, "HEAD"))) return mirror;
  const clone = seatClone(repo);
  if (clone === undefined) throw new DiffHashError(`no seat clone for ${repo}`);
  const url = (await git(exec, ["-C", clone, "remote", "get-url", "origin"], "remote get-url")).trim();
  // A clone that dies half way leaves only the staging directory, never a mirror that looks made.
  const staging = `${mirror}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(stateDir, "marker-git"), { recursive: true });
  await git(exec, ["clone", "--bare", "--single-branch", "--no-tags", "--quiet", "--", url, staging], "clone", fetchEnv);
  renameSync(staging, mirror);
  return mirror;
}

async function git(exec: GitExec, args: readonly string[], what: string, fetchEnv?: GitSourceOptions["fetchEnv"]): Promise<string> {
  const result = await exec(args, { env: { ...HARDENED_GIT_ENV, ...fetchEnv }, timeoutMs: 60_000 });
  if (result.code !== 0) throw new DiffHashError(`git ${what} exited ${result.code}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** A PR head the mirror has not seen yet is fetched by sha; the mirror tracks `main` alone. */
async function ensureCommit(exec: GitExec, mirror: string, sha: string, fetchEnv: GitSourceOptions["fetchEnv"]): Promise<void> {
  if (!OID.test(sha)) throw new DiffHashError(`not a full sha: ${JSON.stringify(sha.slice(0, 80))}`);
  const present = await exec(["-C", mirror, "cat-file", "-e", `${sha}^{commit}`], { env: HARDENED_GIT_ENV });
  if (present.code !== 0) await git(exec, ["-C", mirror, "fetch", "--no-tags", "--quiet", "--", "origin", sha], "fetch", fetchEnv);
}

/** `gitDiffPin` in the mirror, memoised per (repo, head) for 60 s because each call fetches `main`. */
export function diffPinSource(mirrorOf: MirrorOf, { exec = execGit, fetchEnv, now = Date.now }: GitSourceOptions = {}): NonNullable<PinSources["diffPin"]> {
  const cache = new Map<string, { at: number; pin: Promise<DiffPin> }>();
  return (item, head) => {
    const key = `${item.repo.toLowerCase()}@${head}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < PIN_CACHE_MS) return hit.pin;
    const pin = (async () => {
      const mirror = await mirrorOf(item.repo);
      await ensureCommit(exec, mirror, head, fetchEnv);
      return gitDiffPin(exec, mirror, head, fetchEnv === undefined ? {} : { fetchEnv });
    })();
    cache.set(key, { at: now(), pin });
    pin.catch(() => cache.delete(key));
    return pin;
  };
}

type CarryProbe = (item: PrKey, fromHead: string, head: string) => Promise<PinProbe>;

/** The inputs `pinCause` classifies for a MERGE Shepherd carried from `fromHead` to `head`. */
export function carryProbeSource(mirrorOf: MirrorOf, diffPin: NonNullable<PinSources["diffPin"]>, { exec = execGit }: GitSourceOptions = {}): CarryProbe {
  return async (item, fromHead, head) => {
    const [reviewed, current] = [await diffPin(item, fromHead), await diffPin(item, head)];
    const mirror = await mirrorOf(item.repo);
    const mergeUp: MergeUpProof = current.kind === "exact" ? await gitMergeUpCheck(exec, mirror)(fromHead, current) : { ok: false, reason: "the current pin is ambiguous" };
    const parents = (await git(exec, ["-C", mirror, "rev-list", "--parents", "-n", "1", head], "rev-list")).trim().split(" ");
    const [reviewedCore, currentCore] = [await wsBlindCore(exec, mirror, reviewed), await wsBlindCore(exec, mirror, current)];
    return { reviewed, current, mergeUp, headIsMerge: parents.length > 2, wsBlindCoreEqual: reviewedCore !== undefined && reviewedCore === currentCore };
  };
}

async function wsBlindCore(exec: GitExec, mirror: string, pin: DiffPin): Promise<string | undefined> {
  if (pin.kind === "ambiguous") return undefined;
  return serialiseDiff(await git(exec, ["-C", mirror, ...DIFF_HASH_ARGS, "--ignore-all-space", pin.base, pin.head], "diff")).core;
}

/** A commit's tree from whichever mirror holds it; landed pins carry no repo, and a missing commit is no tree. */
export function treeOfSource(mirrors: () => Promise<readonly string[]>, { exec = execGit }: GitSourceOptions = {}): NonNullable<PinSources["treeOf"]> {
  return async (commit) => {
    if (!OID.test(commit)) return undefined;
    for (const mirror of await mirrors()) {
      const result = await exec(["-C", mirror, "rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{tree}`], { env: HARDENED_GIT_ENV });
      if (result.code === 0) return result.stdout.trim();
    }
    return undefined;
  };
}
