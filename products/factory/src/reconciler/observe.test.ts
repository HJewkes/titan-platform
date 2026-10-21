import { describe, expect, it } from "vitest";
import type { BackstopCommit, BackstopDonePr, BackstopOpenPr, BackstopSnapshot, RulesetList } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration } from "../event-log/event-log.js";
import { pullRequestDelivery, reviewDelivery, rulesetDelivery, type PrFact } from "../event-log/repo-shapes.test-helpers.js";
import { INGRESS_KINDS, projectDelivery } from "../ingress/kinds.js";
import { checkRunDelivery, statusDelivery, type CiFact } from "../test-support/a17/ci-shapes.js";
import type { RepoCursor } from "./cursor.js";
import { createObserve, type GuardVerdict, type HeadTipGuard } from "./observe.js";
import type { Observation } from "./service.js";

type AppendResult = ReturnType<typeof appendEvent>;

const REPO = "example-org/widgets";
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const TIP = "d".repeat(40);
const MID = "e".repeat(40);
const OLD = "f".repeat(40);
const CURSOR = "0".repeat(40);
const AT = "2027-01-15T07:00:00Z";
const NOW = Date.parse("2027-01-15T08:00:00Z");

const checkDone = (databaseId: number) => ({ kind: "check", databaseId, name: "build", status: "COMPLETED", conclusion: "SUCCESS", completedAt: AT.replace("Z", ".000Z") }) as const;
const checkRunning = (databaseId: number) => ({ kind: "check", databaseId, name: "build", status: "IN_PROGRESS", conclusion: null, completedAt: null }) as const;
const statusDone = { kind: "status", context: "ci/lint", state: "FAILURE", createdAt: AT } as const;
const commitOf = (oid: string, contexts: BackstopCommit["contexts"] = [checkDone(Number.parseInt(oid.slice(0, 2), 16))]): BackstopCommit => ({ oid, contexts });

function openPr(over: Partial<BackstopOpenPr> = {}): BackstopOpenPr {
  return { number: 7, headRefOid: HEAD, baseRefName: "main", updatedAt: AT, head: commitOf(HEAD, [checkDone(101), statusDone]), reviews: [], ...over };
}

const mergedPr: BackstopDonePr = { number: 8, merged: true, mergedBy: "synthetic-merger", mergeCommit: MERGE, closedAt: AT, updatedAt: "2027-01-15T07:10:00Z" };
const closedPr: BackstopDonePr = { number: 9, merged: false, mergedBy: null, mergeCommit: null, closedAt: AT, updatedAt: "2027-01-15T07:20:00Z" };

function snapshot(over: Partial<BackstopSnapshot> = {}): BackstopSnapshot {
  return { open: [], done: [], main: { tip: TIP, commits: [commitOf(TIP)] }, rateLimit: { cost: 1, remaining: 4999, resetAt: AT, queries: 1 }, ...over };
}

const rulesetList = (rulesets: Record<number, string>): RulesetList => ({ notModified: false, unreadable: false, rulesets, etag: '"r1"' });

/** Answers every read with one verdict, and records which subjects it was asked about. */
function guardAnswering(head: GuardVerdict, tip: GuardVerdict = head): HeadTipGuard & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    confirmHead: (repo, pr, sha) => (asked.push(`${repo}#${pr}@${sha}`), head),
    confirmTip: (repo, branch, sha) => (asked.push(`${repo}:${branch}@${sha}`), tip),
  };
}

const CONFIRMED: GuardVerdict = { kind: "confirmed", by: "fast-forward" };

function observeWith(guard: HeadTipGuard, snap: BackstopSnapshot, cursor: RepoCursor = { main: { value: CURSOR, at: AT } }, rulesets?: RulesetList): Observation {
  return createObserve({ guard, now: () => NOW })(REPO, snap, cursor, rulesets);
}

const kinds = (observation: Observation): string[] => observation.events.map((event) => event.kind);

describe("observe kind set (I3)", () => {
  it("emits every kind the ingress declares, plus RulesChanged, from one snapshot", () => {
    const reviews = [
      { databaseId: 5, state: "APPROVED", submittedAt: AT },
      { databaseId: 6, state: "DISMISSED", submittedAt: AT },
    ];
    const snap = snapshot({ open: [openPr({ reviews })], done: [mergedPr, closedPr] });

    const observation = observeWith(guardAnswering(CONFIRMED), snap, {}, rulesetList({ 9: AT }));

    const ingress = INGRESS_KINDS.flatMap((row) => row.kinds);
    expect(new Set(kinds(observation))).toEqual(new Set([...ingress, "RulesChanged"]));
  });

  it("emits both CI flavours: a check run and a commit status", () => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ open: [openPr()], main: { tip: CURSOR, commits: [] } }));

    const ci = observation.events.filter((event) => event.kind === "CIConcluded").map((event) => event.keys.type);
    expect(ci.sort()).toEqual(["check", "status"]);
  });

  it("leaves source and delivery id for the service to stamp", () => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ open: [openPr()], done: [mergedPr] }));

    expect(observation.events.filter((event) => "source" in event || "deliveryId" in event)).toEqual([]);
  });

  it("emits no CI for a check still running or a status still pending", () => {
    const head = commitOf(HEAD, [checkRunning(101), { kind: "status", context: "ci/lint", state: "PENDING", createdAt: AT }]);

    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ open: [openPr({ head })], main: { tip: CURSOR, commits: [] } }));

    expect(kinds(observation)).not.toContain("CIConcluded");
  });
});

describe("observe stale reads (I7)", () => {
  const unconfirmed: [GuardVerdict, string][] = [
    [{ kind: "stale" }, "stale-read"],
    [{ kind: "pending" }, "unconfirmed"],
    [{ kind: "unknown" }, "unconfirmed"],
  ];

  it.each(unconfirmed)("emits nothing from a head the guard answers %o", (verdict, disagree) => {
    const observation = observeWith(guardAnswering(verdict, CONFIRMED), snapshot({ open: [openPr()], main: { tip: CURSOR, commits: [] } }));

    expect(observation.events.filter((event) => event.kind === "HeadPushed" || event.subject === `${REPO}@${HEAD}`)).toEqual([]);
    expect(observation.disagreements).toEqual([{ class: disagree, subject: `${REPO}#7`, detail: HEAD }]);
  });

  it.each(unconfirmed)("emits nothing from a main tip the guard answers %o, and keeps the cursor", (verdict, disagree) => {
    const observation = observeWith(guardAnswering(CONFIRMED, verdict), snapshot());

    expect(observation.events).toEqual([]);
    expect(observation.disagreements).toEqual([{ class: disagree, subject: `${REPO}:main`, detail: TIP }]);
    expect(observation.cursor.main).toBe(CURSOR);
  });

  it("emits the head, its CI, the tip and main's CI once the guard confirms them", () => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ open: [openPr()] }));

    expect(kinds(observation).sort()).toEqual(["BaseChanged", "CIConcluded", "CIConcluded", "CIConcluded", "HeadPushed", "MainMoved"]);
    expect(observation.disagreements).toEqual([]);
  });

  it("keeps a PR's base and reviews when only its head read is stale", () => {
    const reviews = [{ databaseId: 5, state: "APPROVED", submittedAt: AT }];

    const observation = observeWith(guardAnswering({ kind: "stale" }, CONFIRMED), snapshot({ open: [openPr({ reviews })], main: { tip: CURSOR, commits: [] } }));

    expect(kinds(observation).sort()).toEqual(["BaseChanged", "ReviewSubmitted"]);
  });
});

describe("observe main range (plan §1.3)", () => {
  it("moves the cursor to the tip when every check in the range has finished", () => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: TIP, commits: [commitOf(TIP), commitOf(MID)] } }));

    expect(observation.cursor.main).toBe(TIP);
  });

  it("holds the cursor below the oldest commit whose checks still run, so the next read sees them finish", () => {
    const commits = [commitOf(TIP), commitOf(MID, [checkRunning(202)]), commitOf(OLD)];

    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: TIP, commits } }));

    expect(observation.cursor.main).toBe(OLD);
    expect(observation.events.filter((event) => event.kind === "CIConcluded").map((event) => event.subject)).toEqual([`${REPO}@${TIP}`, `${REPO}@${OLD}`]);
  });

  it("keeps the old cursor when the oldest commit in range is still running", () => {
    const commits = [commitOf(TIP), commitOf(MID, [checkRunning(202)])];

    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: TIP, commits } }));

    expect(observation.cursor.main).toBe(CURSOR);
  });

  it("writes no main cursor when there is none to hold at", () => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: TIP, commits: [commitOf(TIP, [checkRunning(1)])] } }), {});

    expect(observation.cursor).not.toHaveProperty("main");
  });

  it("asks no guard and emits no MainMoved when the tip is the cursor", () => {
    const guard = guardAnswering(CONFIRMED);

    const observation = observeWith(guard, snapshot({ main: { tip: CURSOR, commits: [] } }));

    expect(guard.asked).toEqual([]);
    expect(observation.events).toEqual([]);
    expect(observation.cursor.main).toBe(CURSOR);
  });

  it("emits MainMoved and says so when main no longer descends from the cursor", () => {
    const observation = observeWith(guardAnswering(CONFIRMED, { kind: "confirmed", by: "non-ancestor" }), snapshot());

    expect(kinds(observation)).toContain("MainMoved");
    expect(observation.disagreements).toEqual([{ class: "main-ancestry-lost", subject: `${REPO}:main`, detail: `${CURSOR}..${TIP}` }]);
    expect(observation.cursor.main).toBe(TIP);
  });
});

describe("observe done and ruleset cursors", () => {
  it("moves the done cursor to the newest closed PR and never back", () => {
    const forward = observeWith(guardAnswering(CONFIRMED), snapshot({ done: [mergedPr, closedPr] }));
    const back = observeWith(guardAnswering(CONFIRMED), snapshot({ done: [mergedPr] }), { done: { value: closedPr.updatedAt, at: AT } });

    expect([forward.cursor.done, back.cursor.done]).toEqual([closedPr.updatedAt, closedPr.updatedAt]);
  });

  it("emits RulesChanged only for a ruleset whose stamp moved since the cursor", () => {
    const cursor: RepoCursor = { main: { value: CURSOR, at: AT }, rulesets: { value: JSON.stringify({ 9: AT, 10: AT }), at: AT } };

    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: CURSOR, commits: [] } }), cursor, rulesetList({ 9: AT, 10: "2027-01-15T07:30:00Z" }));

    expect(observation.events.map((event) => event.keys)).toEqual([{ rulesetId: 10, updatedAt: "2027-01-15T07:30:00Z" }]);
    expect(JSON.parse(observation.cursor.rulesets ?? "")).toEqual({ 9: AT, 10: "2027-01-15T07:30:00Z" });
  });

  it.each([{ notModified: true }, { notModified: false, unreadable: true }, undefined] as const)("emits no RulesChanged and keeps the ruleset cursor for %o", (list) => {
    const observation = observeWith(guardAnswering(CONFIRMED), snapshot({ main: { tip: CURSOR, commits: [] } }), { main: { value: CURSOR, at: AT } }, list);

    expect(observation.events).toEqual([]);
    expect(observation.cursor).not.toHaveProperty("rulesets");
  });
});

interface IdentityCase {
  name: string;
  kind: string;
  webhook: [event: string, payload: unknown];
  snapshot: BackstopSnapshot;
  rulesets?: RulesetList;
}

const webhookRepo = "Example-Org/Widgets";
const pr: PrFact = { repo: webhookRepo, pr: 7, head: HEAD, base: "main" };
const ciFact = (over: Partial<CiFact>): CiFact => ({ type: "check", repo: webhookRepo, head: HEAD, context: "build", checkRunId: 101, outcome: "success", at: AT, ...over });
const quietMain = { tip: CURSOR, commits: [] };

const IDENTITY_CASES: IdentityCase[] = [
  { name: "check run", kind: "CIConcluded", webhook: ["check_run", checkRunDelivery(ciFact({}))], snapshot: snapshot({ open: [openPr({ head: commitOf(HEAD, [checkDone(101)]) })], main: quietMain }) },
  {
    name: "commit status",
    kind: "CIConcluded",
    webhook: ["status", statusDelivery(ciFact({ type: "status", context: "ci/lint", outcome: "failure" }))],
    snapshot: snapshot({ open: [openPr({ head: commitOf(HEAD, [statusDone]) })], main: quietMain }),
  },
  { name: "merge", kind: "PRMerged", webhook: ["pull_request", pullRequestDelivery({ ...pr, pr: 8, end: { merged: true, mergeSha: MERGE, closedAt: AT, mergedBy: "synthetic-merger" } })], snapshot: snapshot({ done: [mergedPr], main: quietMain }) },
  { name: "close", kind: "PRClosed", webhook: ["pull_request", pullRequestDelivery({ ...pr, pr: 9, end: { merged: false, mergeSha: null, closedAt: AT } })], snapshot: snapshot({ done: [closedPr], main: quietMain }) },
  { name: "review submitted", kind: "ReviewSubmitted", webhook: ["pull_request_review", reviewDelivery(pr, 5, "submitted")], snapshot: snapshot({ open: [openPr({ reviews: [{ databaseId: 5, state: "APPROVED", submittedAt: AT }] })], main: quietMain }) },
  { name: "review dismissed", kind: "ReviewDismissed", webhook: ["pull_request_review", reviewDelivery(pr, 6, "dismissed")], snapshot: snapshot({ open: [openPr({ reviews: [{ databaseId: 6, state: "DISMISSED", submittedAt: AT }] })], main: quietMain }) },
  { name: "ruleset", kind: "RulesChanged", webhook: ["repository_ruleset", rulesetDelivery(webhookRepo, 9, AT)], snapshot: snapshot({ main: quietMain }), rulesets: rulesetList({ 9: AT }) },
];

function eventLog(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration()]);
  return db;
}

function appendWebhook(db: Db, [event, payload]: IdentityCase["webhook"]): AppendResult {
  const projected = projectDelivery(event, payload);
  if (projected === "ignored") throw new Error(`fixture: ${event} was ignored`);
  return appendEvent(db, { ...projected, source: "webhook", deliveryId: "webhook:synthetic-guid-1", observedAt: AT });
}

function appendBackstop(db: Db, testCase: IdentityCase): AppendResult[] {
  const observation = observeWith(guardAnswering(CONFIRMED), testCase.snapshot, {}, testCase.rulesets);
  return observation.events.filter((event) => event.kind === testCase.kind).map((event) => appendEvent(db, { ...event, source: "backstop" }));
}

const rowsOf = (db: Db, kind: string): number => db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM factory_event WHERE kind = ?").get(kind)?.n ?? 0;

describe("observe dedupes against the ingress (I2)", () => {
  it.each(IDENTITY_CASES)("gives one $name row when the webhook lands first", (testCase) => {
    const db = eventLog();

    appendWebhook(db, testCase.webhook);
    const second = appendBackstop(db, testCase);

    expect(rowsOf(db, testCase.kind)).toBe(1);
    expect(second).toEqual([expect.objectContaining({ inserted: false, by: "occurrence" })]);
  });

  it.each(IDENTITY_CASES)("gives one $name row when the backstop lands first", (testCase) => {
    const db = eventLog();

    const first = appendBackstop(db, testCase);
    const second = appendWebhook(db, testCase.webhook);

    expect(first).toEqual([expect.objectContaining({ inserted: true })]);
    expect(rowsOf(db, testCase.kind)).toBe(1);
    expect(second).toEqual(expect.objectContaining({ inserted: false, by: "occurrence" }));
  });

  it("covers every identity kind the ingress declares", () => {
    const transition = new Set(["HeadPushed", "BaseChanged", "MainMoved"]);
    const identity = new Set(INGRESS_KINDS.flatMap((row) => row.kinds).filter((kind) => !transition.has(kind)));

    expect(new Set(IDENTITY_CASES.map((testCase) => testCase.kind))).toEqual(identity);
  });
});
