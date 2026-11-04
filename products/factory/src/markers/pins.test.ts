import { describe, expect, it } from "vitest";
import type { DiffPin } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration } from "../event-log/event-log.js";
import { advanceEpoch, headEpochMigration } from "../head-guard/epoch-store.js";
import { mergeLogMigration } from "../merge-log.js";
import { pinFor, type PinSources } from "./pins.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const MERGE = "c".repeat(40);
const TREE = "d".repeat(40);
const ITEM = { repo: "O/R", pr: 7 };
const AT = "2026-11-01T12:00:00.000Z";

function memory(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [mergeLogMigration(29), eventLogMigration(30), headEpochMigration(34)]);
  return db;
}

function push(db: Db, head: string, expectedEpoch: number): void {
  advanceEpoch(db, { repo: ITEM.repo, pr: ITEM.pr, expectedEpoch, head, by: expectedEpoch === 0 ? "bootstrap" : "non-ancestor", at: AT });
}

let occurrence = 0;
function log(db: Db, kind: string, subject: string): number {
  occurrence += 1;
  const appended = appendEvent(db, { rule: "identity", source: "webhook", kind, repo: "o/r", subject, keys: {}, occurrenceKey: `v1|${kind}|${occurrence}`, observedAt: AT, payload: {} });
  return appended.seq;
}

function merged(db: Db, outcome: "merged" | "failed"): number {
  const row = "INSERT INTO merge_op (kind, intent_id, path, repo, pr, head_sha, reason_kind, reason_id, actor, at, outcome, merge_commit) VALUES (?, ?, 'lander', 'o/r', 7, ?, 'item', 'x', 'bot', ?, ?, ?)";
  const intent = Number(db.prepare(row).run("intent", null, SHA_A, AT, null, null).lastInsertRowid);
  return Number(db.prepare(row).run("result", intent, SHA_A, AT, outcome, outcome === "merged" ? MERGE : null).lastInsertRowid);
}

const pinOf = (fact: string, sources: PinSources) => pinFor(fact, ITEM, sources, AT);

describe("pinFor", () => {
  it("a tree pin carries the epoch, so A then B then A gives three pins", async () => {
    const db = memory();
    const pins: unknown[] = [];

    for (const [head, epoch] of [[SHA_A, 0], [SHA_B, 1], [SHA_A, 2]] as const) {
      push(db, head, epoch);
      pins.push(await pinOf("ci:green", { db }));
    }

    expect(pins).toEqual([
      { pinClass: "tree", pin: `${SHA_A}@e1`, pinSeq: 1 },
      { pinClass: "tree", pin: `${SHA_B}@e2`, pinSeq: 2 },
      { pinClass: "tree", pin: `${SHA_A}@e3`, pinSeq: 3 },
    ]);
  });

  it("a PR with no epoch row is unpinnable, not pinned at an empty head", async () => {
    const db = memory();

    expect(await pinOf("head:pushed", { db })).toEqual({ unpinnable: "no head epoch row for this PR" });
    expect(await pinOf("verdict:merge", { db, diffPin: () => Promise.reject(new Error("not read")) })).toEqual({ unpinnable: "no head epoch row for this PR" });
  });

  it("an ambiguous diff pin is unpinnable", async () => {
    const db = memory();
    push(db, SHA_A, 0);
    const heads: string[] = [];
    const answer = (pin: DiffPin) => (_item: unknown, head: string) => (heads.push(head), Promise.resolve(pin));

    const ambiguous = await pinOf("verdict:merge", { db, diffPin: answer({ kind: "ambiguous", head: SHA_A, main: SHA_B, bases: [] }) });
    const exact = await pinOf("verdict:merge", { db, diffPin: answer({ kind: "exact", head: SHA_A, base: SHA_B, main: SHA_B, full: "sha256:full", core: "sha256:core" }) });

    expect(ambiguous).toEqual({ unpinnable: "ambiguous merge base: 0 bases" });
    expect(exact).toEqual({ pinClass: "diff", pin: "sha256:full" });
    expect(heads).toEqual([SHA_A, SHA_A]);
  });

  it("an observed pin moves when an event of a producer kind for that subject is appended, and not for another subject or kind", async () => {
    const db = memory();
    const pin = () => pinOf("mergeability", { db });
    const before = await pin();

    log(db, "HeadPushed", "o/r#8");
    log(db, "ReviewSubmitted", "o/r#7");
    const unmoved = await pin();
    const itemSeq = log(db, "BaseChanged", "o/r#7");
    const repoSeq = log(db, "MainMoved", "o/r:main");
    const moved = await pin();

    expect(before).toEqual({ pinClass: "observed", pin: "o/r#7|BaseChanged,HeadPushed,MainMoved@0/0", pinSeq: 0 });
    expect(unmoved).toEqual(before);
    expect(moved).toEqual({ pinClass: "observed", pin: `o/r#7|BaseChanged,HeadPushed,MainMoved@${itemSeq}/${repoSeq}`, pinSeq: repoSeq });
  });

  it("a TTL fact is pinned `ttl` with expires_at five minutes after the write for hold", async () => {
    expect(await pinOf("hold", { db: memory() })).toEqual({ pinClass: "observed", pin: "ttl", expiresAt: "2026-11-01T12:05:00.000Z" });
  });

  it("a landed pin names the merge commit's tree and the merge_op row", async () => {
    const db = memory();
    const treeOf = (commit: string) => Promise.resolve(commit === MERGE ? TREE : undefined);
    merged(db, "failed");
    const failedOnly = await pinOf("landed", { db, treeOf });
    const id = merged(db, "merged");

    expect(failedOnly).toEqual({ unpinnable: "no merged result row in the merge log" });
    expect(await pinOf("landed", { db, treeOf })).toEqual({ pinClass: "landed", pin: `${TREE}|merge_op:${id}@r0`, pinSeq: 0 });
  });

  it("a fact the rule file does not list is unpinnable", async () => {
    const db = memory();

    expect(await pinOf("mood:sunny", { db })).toEqual({ unpinnable: "mood:sunny is not in the pin-class rule file" });
    expect(await pinOf("contract:approved", { db })).toEqual({ unpinnable: "no producer kinds are declared for this item fact (O5)" });
  });
});
