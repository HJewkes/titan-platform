import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration, readEvents } from "./event-log.js";
import {
  fromBackstopDonePr,
  fromBackstopMain,
  fromBackstopOpenPr,
  fromBackstopRulesets,
  fromPullRequestDelivery,
  fromPushDelivery,
  fromReviewDelivery,
  fromRulesetDelivery,
  repoEvent,
  repoKey,
  type RepoObservation,
} from "./repo-keys.js";
import { backstopDonePr, backstopOpenPr, pullRequestDelivery, pushDelivery, reviewDelivery, rulesetDelivery, type PrFact } from "./repo-shapes.test-helpers.js";

const HEAD = "a".repeat(40);
const MERGE = "m".repeat(40);
const OBSERVED = "2026-10-17T12:00:00.000Z";
const PR: PrFact = { repo: "Acme/Widgets", pr: 7, head: HEAD, base: "main" };
const MERGED: PrFact = { ...PR, end: { merged: true, mergeSha: MERGE, closedAt: "2026-10-17T11:00:00Z", mergedBy: "octocat" } };
const CLOSED: PrFact = { ...PR, end: { merged: false, mergeSha: null, closedAt: "2026-10-17T11:30:00Z" } };

function db(): Db {
  const opened = openDatabase(":memory:");
  runMigrations(opened, [eventLogMigration()]);
  return opened;
}

const identityKeys = (observations: RepoObservation[]): string[] => observations.flatMap((o) => (o.rule === "identity" ? [repoKey(o)] : []));

describe("PR, review and ruleset occurrence keys", () => {
  it.each([
    ["PRMerged on the PR and merge sha", MERGED, `v1|PRMerged|acme/widgets|7|${MERGE}`],
    ["PRClosed on the PR and closed_at", CLOSED, "v1|PRClosed|acme/widgets|7|2026-10-17T11:30:00Z"],
  ])("derives %s from the webhook and the GraphQL shape alike", (_name, fact, expected) => {
    expect(identityKeys(fromPullRequestDelivery(pullRequestDelivery(fact)))).toEqual([expected]);
    expect(identityKeys(fromBackstopDonePr(fact.repo, backstopDonePr(fact)))).toEqual([expected]);
  });

  it("keeps merged_by in the keys but out of the merge key", () => {
    const [byWebhook] = fromPullRequestDelivery(pullRequestDelivery(MERGED)).filter((o) => o.kind === "PRMerged");
    const [byOther] = fromBackstopDonePr("acme/widgets", backstopDonePr({ ...MERGED, end: { ...MERGED.end!, mergedBy: "someone-else" } }));

    expect(byWebhook?.rule === "identity" && byWebhook.keys.mergedBy).toBe("octocat");
    expect(identityKeys([byWebhook!])).toEqual(identityKeys([byOther!]));
  });

  it.each([
    ["submitted", "APPROVED", "ReviewSubmitted"],
    ["dismissed", "DISMISSED", "ReviewDismissed"],
  ] as const)("derives a review %s key on the PR, review id and action in both shapes", (action, state, kind) => {
    const expected = `v1|${kind}|acme/widgets|7|99|${action}`;
    const webhook = fromReviewDelivery(reviewDelivery(PR, 99, action));

    expect(identityKeys(webhook === undefined ? [] : [webhook])).toEqual([expected]);
    expect(identityKeys(fromBackstopOpenPr(PR.repo, backstopOpenPr({ ...PR, reviews: [{ id: 99, state }] })))).toEqual([expected]);
  });

  it("derives RulesChanged on the ruleset id and updated_at in UTC seconds from both shapes", () => {
    const webhook = fromRulesetDelivery(rulesetDelivery("Acme/Widgets", 5, "2026-10-17T11:00:00Z"));

    expect(identityKeys(webhook === undefined ? [] : [webhook])).toEqual(["v1|RulesChanged|acme/widgets|5|2026-10-17T11:00:00Z"]);
    expect(identityKeys(fromBackstopRulesets("Acme/Widgets", { 5: "2026-10-17T13:00:00.000+02:00" }))).toEqual(["v1|RulesChanged|acme/widgets|5|2026-10-17T11:00:00Z"]);
  });

  it("keys a deleted ruleset apart from its last edit", () => {
    const deleted = fromRulesetDelivery(rulesetDelivery("o/r", 5, "2026-10-17T11:00:00Z", "deleted"));

    expect(identityKeys(deleted === undefined ? [] : [deleted])).toEqual(["v1|RulesChanged|o/r|5|deleted"]);
  });

  it("emits no ending for an open PR, a merge with no readable sha, a pending review, a review edit or an organization ruleset", () => {
    const noSha: PrFact = { ...MERGED, end: { ...MERGED.end!, mergeSha: null } };

    expect(identityKeys(fromPullRequestDelivery(pullRequestDelivery(PR)))).toEqual([]);
    expect(fromBackstopDonePr(noSha.repo, backstopDonePr(noSha))).toEqual([]);
    expect(identityKeys(fromBackstopOpenPr(PR.repo, backstopOpenPr({ ...PR, reviews: [{ id: 1, state: "PENDING" }] })))).toEqual([]);
    expect(fromReviewDelivery(reviewDelivery(PR, 1, "edited"))).toBeUndefined();
    expect(fromRulesetDelivery({ action: "edited", repository_ruleset: { id: 1, updated_at: "2026-10-17T11:00:00Z" } })).toBeUndefined();
  });

  it.each([
    ["a merge", MERGED],
    ["a close", CLOSED],
  ])("stores one row when the webhook and the backstop report %s", (_name, fact) => {
    const log = db();
    const [webhook] = fromPullRequestDelivery(pullRequestDelivery(fact)).filter((o) => o.rule === "identity");
    const [backstop] = fromBackstopDonePr(fact.repo, backstopDonePr(fact));
    const first = appendEvent(log, repoEvent(webhook!, { source: "webhook", observedAt: OBSERVED, deliveryId: "d1" }));
    const second = appendEvent(log, repoEvent(backstop!, { source: "backstop", observedAt: OBSERVED }));

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false, seq: first.seq, by: "occurrence" });
    expect(readEvents(log, { subject: "acme/widgets#7", sinceSeq: 0 })).toHaveLength(1);
  });
});

describe("transition kinds", () => {
  it("reads HeadPushed and BaseChanged on repo#pr and MainMoved on repo:branch from both shapes", () => {
    const transitions = (observations: RepoObservation[]) => observations.flatMap((o) => (o.rule === "transition" ? [[o.kind, o.subject, o.value]] : []));
    const expectedPr = [["HeadPushed", "acme/widgets#7", HEAD], ["BaseChanged", "acme/widgets#7", "main"]];

    expect(transitions(fromPullRequestDelivery(pullRequestDelivery(PR)))).toEqual(expectedPr);
    expect(transitions(fromBackstopOpenPr(PR.repo, backstopOpenPr(PR)))).toEqual(expectedPr);
    expect(transitions([fromPushDelivery(pushDelivery("Acme/Widgets", "main", HEAD))!])).toEqual([["MainMoved", "acme/widgets:main", HEAD]]);
    expect(transitions([fromBackstopMain("Acme/Widgets", "main", HEAD)])).toEqual([["MainMoved", "acme/widgets:main", HEAD]]);
  });

  it("ignores a push to another branch and a branch deletion", () => {
    expect(fromPushDelivery(pushDelivery("o/r", "feature", HEAD))).toBeUndefined();
    expect(fromPushDelivery({ ...(pushDelivery("o/r", "main", "0".repeat(40)) as object), deleted: true })).toBeUndefined();
  });

  it("gives each row of one delivery its own namespaced delivery id, and a backstop row none", () => {
    const observations = fromPullRequestDelivery(pullRequestDelivery(MERGED));

    expect(observations.map((o) => repoEvent(o, { source: "webhook", observedAt: OBSERVED, deliveryId: "d1" }).deliveryId)).toEqual([
      "webhook:d1:HeadPushed",
      "webhook:d1:BaseChanged",
      "webhook:d1:PRMerged",
    ]);
    expect(repoEvent(observations[0]!, { source: "backstop", observedAt: OBSERVED }).deliveryId).toBeUndefined();
  });

  it("appends every row of one closing delivery, and a retry of it appends none", () => {
    const log = db();
    const append = () => fromPullRequestDelivery(pullRequestDelivery(MERGED)).map((o) => appendEvent(log, repoEvent(o, { source: "webhook", observedAt: OBSERVED, deliveryId: "d1" })));

    expect(append().map((r) => r.inserted)).toEqual([true, true, true]);
    expect(append().map((r) => (r.inserted ? "inserted" : r.by))).toEqual(["delivery", "delivery", "delivery"]);
  });
});
