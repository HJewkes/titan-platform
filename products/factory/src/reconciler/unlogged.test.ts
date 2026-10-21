import type { BackstopReview, BackstopSnapshot } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { isNotFactory, recordBotIntent } from "../bot-intent.js";
import { BOT_LOGIN, commit, REPO, rig } from "./fakes.test-helpers.js";
import { createReconciler } from "./service.js";
import { botActions } from "./unlogged.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const TRAIN_SHA = "c".repeat(40);
const AT = "2027-01-15T07:00:00Z";
const ONE_REPO = { repos: [REPO], fullEvery: 1 };

const review = (databaseId: number, login: string, oid = HEAD): BackstopReview => ({ databaseId, state: "APPROVED", submittedAt: AT, author: { login }, commit: { oid } });

function snapshotWith(over: Partial<BackstopSnapshot>): BackstopSnapshot {
  return { open: [], done: [], main: { tip: "c1", commits: [commit("c1")] }, trains: [], rateLimit: { cost: 1, remaining: 4999, resetAt: AT, queries: 1 }, ...over };
}

const openPr = (reviews: BackstopReview[], head: BackstopSnapshot["main"]["commits"][number] | null = null) => ({ number: 7, headRefOid: HEAD, baseRefName: "main", updatedAt: AT, head, reviews });

async function pass(snapshot: BackstopSnapshot, arrange: (db: Db) => void = () => undefined, passes = 1) {
  const r = rig();
  r.github.snapshot = () => snapshot;
  arrange(r.db);
  const service = createReconciler(ONE_REPO, r.deps);
  for (let n = 0; n < passes; n += 1) await service.tick();
  return { r, alarms: r.lines.filter((line) => line.msg.startsWith("ops-alarm")).map((line) => line.msg) };
}

function mergeIntent(db: Db, pr: number): void {
  db.prepare("INSERT INTO merge_op (kind, path, repo, pr, head_sha, reason_kind, reason_id, actor, at) VALUES ('intent', 'lander', ?, ?, ?, 'item', 'synthetic-item', 'lander', ?)").run(REPO, pr, HEAD, AT);
}

describe("BotActionUnlogged (TP-3094 C7, V9)", () => {
  it("alarms on a bot review with no intent row and marks it not-factory", async () => {
    const { r, alarms } = await pass(snapshotWith({ open: [openPr([review(501, BOT_LOGIN)])] }));

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} review 501`]);
    expect(isNotFactory(r.db, REPO, "review", "501")).toBe(true);
  });

  it("raises nothing for a bot review whose intent row names its PR and commit", async () => {
    const { r, alarms } = await pass(snapshotWith({ open: [openPr([review(501, BOT_LOGIN)])] }), (db) => recordBotIntent(db, { repo: REPO, kind: "review", subject: `7@${HEAD}`, at: AT }));

    expect(alarms).toEqual([]);
    expect(isNotFactory(r.db, REPO, "review", "501")).toBe(false);
  });

  it("alarms on a bot review when the only intent row of its kind names another commit", async () => {
    const { alarms } = await pass(snapshotWith({ open: [openPr([review(501, BOT_LOGIN)])] }), (db) => recordBotIntent(db, { repo: REPO, kind: "review", subject: `7@${OTHER_HEAD}`, at: AT }));

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} review 501`]);
  });

  it("alarms on a shepherd-train push with no intent row, and not on one with a row", async () => {
    const trains = [{ ref: "shepherd-train/widgets", oid: TRAIN_SHA }, { ref: "shepherd-train/gadgets", oid: TRAIN_SHA }];
    const { alarms } = await pass(snapshotWith({ trains }), (db) => recordBotIntent(db, { repo: REPO, kind: "train-push", subject: `shepherd-train/gadgets@${TRAIN_SHA}`, at: AT }));

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} train-push shepherd-train/widgets@${TRAIN_SHA}`]);
  });

  it("checks bot merges against the merge log's intent rows", async () => {
    const merged = (number: number) => ({ number, merged: true, mergedBy: BOT_LOGIN, mergeCommit: OTHER_HEAD, closedAt: AT, updatedAt: AT });
    const { alarms } = await pass(snapshotWith({ done: [merged(8), merged(9)] }), (db) => mergeIntent(db, 8));

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} merge 9`]);
  });

  it("alarms on a bot status with no intent row, once though both an open head and main carry it", async () => {
    const status = { kind: "status" as const, context: "factory/gate", state: "SUCCESS", createdAt: AT, creator: BOT_LOGIN };
    const head = { oid: HEAD, contexts: [status] };
    const { alarms } = await pass(snapshotWith({ open: [openPr([], head)], main: { tip: HEAD, commits: [head] } }));

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} status ${HEAD}/factory/gate`]);
  });

  it("ignores reviews, statuses and merges by anyone but the bot", async () => {
    const status = { kind: "status" as const, context: "ci/legacy", state: "SUCCESS", createdAt: AT, creator: "synthetic-dev" };
    const done = [{ number: 8, merged: true, mergedBy: "synthetic-dev", mergeCommit: OTHER_HEAD, closedAt: AT, updatedAt: AT }];
    const { alarms } = await pass(snapshotWith({ open: [openPr([review(502, "synthetic-dev")], { oid: HEAD, contexts: [status] })], done }));

    expect(alarms).toEqual([]);
  });

  it("alarms once per action across passes, since the not-factory mark persists", async () => {
    const { alarms } = await pass(snapshotWith({ open: [openPr([review(501, BOT_LOGIN)])] }), undefined, 3);

    expect(alarms).toEqual([`ops-alarm BotActionUnlogged ${REPO} review 501`]);
  });
});

describe("botActions", () => {
  it("matches the bot's login with or without the [bot] suffix, in any case", () => {
    const snapshot = snapshotWith({ open: [openPr([review(1, "Synthetic-Bot[bot]"), review(2, "synthetic-bot")])] });

    expect(botActions(snapshot, "synthetic-bot[bot]").map((action) => action.id)).toEqual(["1", "2"]);
  });

  it("gives a review GitHub reports on no commit a subject no intent row can name", () => {
    const snapshot = snapshotWith({ open: [openPr([{ ...review(1, BOT_LOGIN), commit: null }])] });

    expect(botActions(snapshot, BOT_LOGIN)).toEqual([{ kind: "review", id: "1", subject: "7@unknown" }]);
  });
});
