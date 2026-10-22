import type { BackstopSnapshot } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { classifyTipRead, guardReadHead, type Ancestry, type GuardStore, type HeadClass, type Unavailable } from "../head-guard/guard.js";
import type { RepoCursor } from "./cursor.js";
import type { GuardVerdict, HeadTipGuard } from "./observe.js";

/** A ref `ls-remote` names: a PR's `refs/pull/<n>/head`, or a branch. */
export type RemoteRef = { pr: number } | { branch: string };

/** TP-3097's second opinions on a read, from the bot side: GitHub's compare, and `git ls-remote`. */
export interface GuardReads {
  /** How `head` relates to `base`: `ahead` is a descendant. */
  ancestry(repo: string, base: string, head: string): Promise<Ancestry | Unavailable>;
  /** The sha the ref names, or null when the remote has no such ref. */
  lsRemote(repo: string, ref: RemoteRef): Promise<string | null | Unavailable>;
}

export interface GuardVerdictDeps extends GuardReads {
  db: Db;
  now: () => number;
}

const BRANCH = "main";

/** A sha the guard never ran on, or one it could not read, cannot be confirmed. */
const UNREAD: GuardVerdict = { kind: "unknown" };

/**
 * Runs the guard on every head and the main tip a snapshot read, before observe, and answers observe's sync guard from
 * the verdicts. A head the guard confirms moves its epoch here, so observe itself reads and writes nothing.
 */
export async function guardVerdicts(repo: string, snapshot: BackstopSnapshot, cursor: RepoCursor, deps: GuardVerdictDeps): Promise<HeadTipGuard> {
  const heads = new Map<number, { sha: string; verdict: GuardVerdict }>();
  for (const pr of snapshot.open) heads.set(pr.number, { sha: pr.headRefOid, verdict: await headVerdict(repo, pr.number, pr.headRefOid, deps) });
  const from = cursor.main?.value ?? null;
  const tip = { sha: snapshot.main.tip, from, verdict: await tipVerdict(repo, snapshot.main.tip, from, deps) };
  return {
    confirmHead: (_repo, pr, sha) => {
      const head = heads.get(pr);
      return head?.sha === sha ? head.verdict : UNREAD;
    },
    confirmTip: (_repo, _branch, sha, at) => (tip.sha === sha && tip.from === at ? tip.verdict : UNREAD),
  };
}

async function headVerdict(repo: string, pr: number, sha: string, deps: GuardVerdictDeps): Promise<GuardVerdict> {
  const store: GuardStore = {
    db: deps.db,
    ancestry: (key, base, head) => deps.ancestry(key.repo, base, head),
    lsRemote: (key) => deps.lsRemote(key.repo, { pr: key.pr }),
    now: () => new Date(deps.now()),
  };
  const result = await guardReadHead(store, { repo, pr }, sha);
  if ("kind" in result) return UNREAD;
  if (result.outcome === "same" || result.outcome === "confirmed") return { kind: "confirmed" };
  return { kind: result.outcome };
}

/** The tip is classified against the cursor, the last tip scanned; one still at the cursor reads as `same`, with no read. */
async function tipVerdict(repo: string, tip: string, from: string | null, deps: GuardVerdictDeps): Promise<GuardVerdict> {
  const reads = { ancestry: (base: string, head: string) => deps.ancestry(repo, base, head), lsRemote: () => deps.lsRemote(repo, { branch: BRANCH }), now: () => new Date(deps.now()) };
  return tipAnswer(await classifyTipRead(reads, from, tip));
}

/** A tip confirmed any way but forward from the cursor left the cursor's line. */
function tipAnswer(verdict: HeadClass): GuardVerdict {
  if (verdict.kind === "unavailable" || verdict.kind === "suspect") return UNREAD;
  if (verdict.kind === "stale") return { kind: "stale" };
  if (verdict.kind === "same" || verdict.by === "fast-forward" || verdict.by === "bootstrap") return { kind: "confirmed" };
  return { kind: "confirmed", by: "non-ancestor" };
}
