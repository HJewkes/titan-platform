import type { BackstopSnapshot } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { advanceEpoch, headEpochMigration, readEpoch } from "../head-guard/epoch-store.js";
import type { Ancestry, Unavailable } from "../head-guard/guard.js";
import type { RepoCursor } from "./cursor.js";
import { guardVerdicts, type GuardVerdictDeps, type RemoteRef } from "./guard-verdicts.js";

const REPO = "example-org/widgets";
const AT = "2027-01-15T08:00:00.000Z";
const [OLD, NEW, TIP, CURSOR] = ["a1", "a2", "c2", "c1"].map((sha) => sha.padEnd(40, "0")) as [string, string, string, string];
const DOWN: Unavailable = { kind: "unavailable" };

interface Script {
  ancestry?: Ancestry | Unavailable;
  remote?: (ref: RemoteRef) => string | null;
}

function deps(script: Script = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, [headEpochMigration()]);
  const asked: string[] = [];
  const guardDeps: GuardVerdictDeps = {
    db,
    now: () => Date.parse(AT),
    ancestry: (_repo, base, head) => (asked.push(`compare ${base.slice(0, 2)}...${head.slice(0, 2)}`), Promise.resolve(script.ancestry ?? "ahead")),
    lsRemote: (_repo, ref) => (asked.push(`ls-remote ${"pr" in ref ? `#${ref.pr}` : ref.branch}`), Promise.resolve(script.remote?.(ref) ?? null)),
  };
  return { db, asked, guardDeps };
}

function snapshot(head: string | null, tip = TIP): BackstopSnapshot {
  const open = head === null ? [] : [{ number: 7, headRefOid: head, baseRefName: "main", updatedAt: AT, head: null, reviews: [] }];
  return { open, done: [], main: { tip, commits: [] }, trains: [], rateLimit: { cost: 1, remaining: 4999, resetAt: AT, queries: 1 } };
}

const at = (main: string | null): RepoCursor => (main === null ? {} : { main: { value: main, at: AT } });

describe("guard verdicts on an open PR's head (TP-3097 through TP-3431)", () => {
  it("confirms a first head ls-remote agrees with, and stores it as the PR's epoch", async () => {
    const { db, guardDeps } = deps({ remote: () => NEW });

    const guard = await guardVerdicts(REPO, snapshot(NEW), at(TIP), guardDeps);

    expect(guard.confirmHead(REPO, 7, NEW)).toEqual({ kind: "confirmed" });
    expect(readEpoch(db, { repo: REPO, pr: 7 })).toMatchObject({ head: NEW, epoch: 1 });
  });

  it("answers stale for an ancestor of the stored head while ls-remote still shows the stored one, and moves nothing", async () => {
    const { db, guardDeps } = deps({ ancestry: "behind", remote: () => NEW });
    advanceEpoch(db, { repo: REPO, pr: 7, expectedEpoch: 0, head: NEW, by: "bootstrap", at: AT });

    const guard = await guardVerdicts(REPO, snapshot(OLD), at(TIP), guardDeps);

    expect(guard.confirmHead(REPO, 7, OLD)).toEqual({ kind: "stale" });
    expect(readEpoch(db, { repo: REPO, pr: 7 })).toMatchObject({ head: NEW, epoch: 1 });
  });

  it("confirms a fast-forward of the stored head without asking ls-remote", async () => {
    const { db, asked, guardDeps } = deps({ ancestry: "ahead" });
    advanceEpoch(db, { repo: REPO, pr: 7, expectedEpoch: 0, head: OLD, by: "bootstrap", at: AT });

    const guard = await guardVerdicts(REPO, snapshot(NEW), at(TIP), guardDeps);

    expect(guard.confirmHead(REPO, 7, NEW)).toEqual({ kind: "confirmed" });
    expect(asked).toEqual([`compare a1...a2`]);
  });

  it("answers unknown when the compare could not be read", async () => {
    const { db, guardDeps } = deps({ ancestry: DOWN });
    advanceEpoch(db, { repo: REPO, pr: 7, expectedEpoch: 0, head: OLD, by: "bootstrap", at: AT });

    const guard = await guardVerdicts(REPO, snapshot(NEW), at(TIP), guardDeps);

    expect(guard.confirmHead(REPO, 7, NEW)).toEqual({ kind: "unknown" });
  });

  it("confirms nothing the guard did not run on", async () => {
    const { guardDeps } = deps({ remote: () => NEW });

    const guard = await guardVerdicts(REPO, snapshot(NEW), at(TIP), guardDeps);

    expect([guard.confirmHead(REPO, 7, OLD), guard.confirmHead(REPO, 8, NEW)]).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
  });
});

describe("guard verdicts on the main tip (TP-3431)", () => {
  it.each([
    { name: "a first tip ls-remote agrees with", cursor: null, script: { remote: () => TIP }, verdict: { kind: "confirmed" } },
    { name: "a first tip ls-remote disagrees with", cursor: null, script: { remote: () => CURSOR }, verdict: { kind: "stale" } },
    { name: "a fast-forward of the cursor", cursor: CURSOR, script: { ancestry: "ahead" }, verdict: { kind: "confirmed" } },
    { name: "a tip that diverged from the cursor", cursor: CURSOR, script: { ancestry: "diverged" }, verdict: { kind: "confirmed", by: "non-ancestor" } },
    { name: "an ancestor of the cursor that ls-remote shows", cursor: CURSOR, script: { ancestry: "behind", remote: () => TIP }, verdict: { kind: "confirmed", by: "non-ancestor" } },
    { name: "an ancestor of the cursor while ls-remote shows the cursor", cursor: CURSOR, script: { ancestry: "behind", remote: () => CURSOR }, verdict: { kind: "stale" } },
    { name: "a tip GitHub's compare cannot find", cursor: CURSOR, script: { ancestry: "missing" }, verdict: { kind: "stale" } },
    { name: "a tip whose compare could not be read", cursor: CURSOR, script: { ancestry: DOWN }, verdict: { kind: "unknown" } },
  ] as const)("answers $verdict.kind for $name", async ({ cursor, script, verdict }) => {
    const { guardDeps } = deps(script);

    const guard = await guardVerdicts(REPO, snapshot(null), at(cursor), guardDeps);

    expect(guard.confirmTip(REPO, "main", TIP, cursor)).toEqual(verdict);
  });

  it("reads nothing for a tip still at the cursor", async () => {
    const { asked, guardDeps } = deps();

    await guardVerdicts(REPO, snapshot(null, CURSOR), at(CURSOR), guardDeps);

    expect(asked).toEqual([]);
  });

  it("asks ls-remote for main's branch, and each open PR for its pull head", async () => {
    const { asked, guardDeps } = deps({ remote: (ref) => ("pr" in ref ? NEW : TIP) });

    await guardVerdicts(REPO, snapshot(NEW), at(null), guardDeps);

    expect(asked).toEqual(["ls-remote #7", "ls-remote main"]);
  });

  it("confirms the tip only against the cursor it was classified from", async () => {
    const { guardDeps } = deps({ ancestry: "ahead" });

    const guard = await guardVerdicts(REPO, snapshot(null), at(CURSOR), guardDeps);

    expect([guard.confirmTip(REPO, "main", TIP, null), guard.confirmTip(REPO, "main", CURSOR, CURSOR)]).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
  });
});
