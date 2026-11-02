import type { DiffPin } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { newestSeq } from "../event-log/event-log.js";
import { readEpoch, type PrKey } from "../head-guard/epoch-store.js";
import { factRule, type PinClass } from "../registry/pin-classes.js";

/** The injected reads; pinning does no I/O but SQLite and these. `diffPin` is `gitDiffPin` live, `treeOf` a commit's tree. */
export interface PinSources {
  db: Db;
  diffPin?: (item: PrKey, head: string) => Promise<DiffPin>;
  treeOf?: (commit: string) => Promise<string | undefined>;
}

export type Pin = { pinClass: PinClass; pin: string; pinSeq?: number; expiresAt?: string } | { unpinnable: string };

/** The marker item key, matching the epoch store's key and the event log's PR subject. */
export const itemKey = (item: PrKey): string => `${item.repo.toLowerCase()}#${item.pr}`;

/** The pin `fact` takes for `item` now (TP-3107 plan §2); an unpinnable fact is ABSENT, with the reason. */
export async function pinFor(fact: string, item: PrKey, sources: PinSources, now: string): Promise<Pin> {
  const rule = factRule(fact);
  if (rule === undefined) return { unpinnable: `${fact} is not in the pin-class rule file` };
  const producer = rule.producer ?? [];
  switch (rule.pinClass) {
    case "tree":
      return treePin(sources.db, item);
    case "diff":
      return diffPinOf(item, sources);
    case "observed":
      return producer.length > 0 ? observedPin("observed", producer, item, sources.db) : ttlPin(rule.ttl, now);
    case "item":
      return producer.length > 0 ? observedPin("item", producer, item, sources.db) : { unpinnable: "no producer kinds are declared for this item fact (O5)" };
    case "landed":
      return landedPin(item, sources);
  }
}

// The epoch sits inside the pin, not only in pin_seq, because identity excludes pin_seq: A then B then A must not match epoch 1's marker.
function treePin(db: Db, item: PrKey): Pin {
  const stored = readEpoch(db, item);
  if (stored === undefined) return { unpinnable: "no head epoch row for this PR" };
  return { pinClass: "tree", pin: `${stored.head}@e${stored.epoch}`, pinSeq: stored.epoch };
}

async function diffPinOf(item: PrKey, sources: PinSources): Promise<Pin> {
  const stored = readEpoch(sources.db, item);
  if (stored === undefined) return { unpinnable: "no head epoch row for this PR" };
  if (sources.diffPin === undefined) return { unpinnable: "no diff pin source" };
  const diff = await sources.diffPin(item, stored.head);
  if (diff.kind === "ambiguous") return { unpinnable: `ambiguous merge base: ${diff.bases.length} bases` };
  return { pinClass: "diff", pin: diff.full };
}

const PR_SCOPED = new Set(["HeadPushed", "BaseChanged", "PRMerged", "PRClosed"]);

/** The subject each producer kind is logged under (event-log/repo-keys.ts); undefined for a kind with no known subject. */
function subjectOf(kind: string, item: PrKey): string | undefined {
  const repo = item.repo.toLowerCase();
  if (PR_SCOPED.has(kind)) return itemKey(item);
  if (kind === "MainMoved") return `${repo}:main`;
  if (kind === "RulesChanged") return repo;
  return undefined;
}

function observedPin(pinClass: PinClass, kinds: readonly string[], item: PrKey, db: Db): Pin {
  const bySubject = new Map<string, string[]>();
  for (const kind of kinds) {
    const subject = subjectOf(kind, item);
    if (subject === undefined) return { unpinnable: `producer kind ${kind} has no known subject` };
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), kind]);
  }
  const groups = [...bySubject].sort(([a], [b]) => Number(b === itemKey(item)) - Number(a === itemKey(item)) || (a < b ? -1 : 1));
  const seqs = groups.map(([subject, group]) => newestSeq(db, { subject, kinds: group }));
  return { pinClass, pin: `${groups[0]![0]}|${[...kinds].sort().join(",")}@${seqs.join("/")}`, pinSeq: Math.max(...seqs) };
}

const DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

function ttlPin(ttl: string | undefined, now: string): Pin {
  const parts = ttl === undefined ? null : DURATION.exec(ttl);
  if (parts === null || parts.slice(1).every((part) => part === undefined)) return { unpinnable: `no usable TTL: ${ttl ?? "none"}` };
  const [hours, minutes, seconds] = parts.slice(1).map((part) => Number(part ?? 0));
  const ms = ((hours! * 60 + minutes!) * 60 + seconds!) * 1000;
  return { pinClass: "observed", pin: "ttl", expiresAt: new Date(Date.parse(now) + ms).toISOString() };
}

async function landedPin(item: PrKey, sources: PinSources): Promise<Pin> {
  const row = sources.db
    .prepare<[string, number], { id: number; merge_commit: string }>("SELECT id, merge_commit FROM merge_op WHERE kind = 'result' AND outcome = 'merged' AND lower(repo) = ? AND pr = ? ORDER BY id DESC LIMIT 1")
    .get(item.repo.toLowerCase(), item.pr);
  if (row === undefined) return { unpinnable: "no merged merge_op result row" };
  const tree = await sources.treeOf?.(row.merge_commit);
  if (tree === undefined) return { unpinnable: `no tree for merge commit ${row.merge_commit}` };
  const reverted = newestSeq(sources.db, { subject: itemKey(item), kinds: ["Reverted"] });
  return { pinClass: "landed", pin: `${tree}|merge_op:${row.id}@r${reverted}`, pinSeq: reverted };
}
