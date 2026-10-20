import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration, headSeq, MAX_PAYLOAD_BYTES } from "../event-log/event-log.js";
import { ciEvent, fromBackstopContext } from "../event-log/ci-keys.js";
import { fromBackstopDonePr, fromBackstopMain, fromBackstopOpenPr, fromBackstopRulesets, repoEvent } from "../event-log/repo-keys.js";
import { backstopDonePr, backstopOpenPr, pullRequestDelivery, pushDelivery, reviewDelivery, rulesetDelivery, type PrFact } from "../event-log/repo-shapes.test-helpers.js";
import { backstopNode, checkRunDelivery, statusDelivery, type CiFact } from "../test-support/a17/ci-shapes.js";
import { INGRESS_KINDS, projectDelivery } from "./kinds.js";

const MARKER = "MARKER-user-text-zq81";
const A = "a".repeat(40);
const M = "c".repeat(40);
const AT = "2026-10-17T10:00:00Z";

const check: CiFact = { type: "check", repo: "Acme/Widgets", head: A, context: "build", checkRunId: 101, outcome: "success", at: AT };
const status: CiFact = { type: "status", repo: "Acme/Widgets", head: A, context: "ci", outcome: "failure", at: AT };
const pr: PrFact = { repo: "Acme/Widgets", pr: 7, head: A, base: "main" };
const merged: PrFact = { ...pr, end: { merged: true, mergeSha: M, closedAt: AT, mergedBy: "octo" } };
const closed: PrFact = { ...pr, end: { merged: false, mergeSha: null, closedAt: AT } };

/** The PR delivery with user text a projection must not carry. */
function withText(delivery: Record<string, unknown>): Record<string, unknown> {
  const pull = delivery.pull_request as Record<string, unknown>;
  return { ...delivery, pull_request: { ...pull, title: MARKER, body: MARKER } };
}

const edited = (changes: unknown): unknown => ({ ...pullRequestDelivery(pr, "edited"), changes });

function kindOf(event: string, payload: unknown): string {
  const projected = projectDelivery(event, payload);
  if (projected === "ignored") return "ignored";
  return projected.kind;
}

describe("projectDelivery kinds", () => {
  // Mutation killed: mapping every `closed` to PRMerged.
  it("projects a merged close as PRMerged and an unmerged close as PRClosed", () => {
    expect(kindOf("pull_request", pullRequestDelivery(merged))).toBe("PRMerged");
    expect(kindOf("pull_request", pullRequestDelivery(closed))).toBe("PRClosed");
  });

  it("routes each listed event and action to its kind", () => {
    const rows: [string, unknown, string][] = [
      ["check_run", checkRunDelivery(check), "CIConcluded"],
      ["status", statusDelivery(status), "CIConcluded"],
      ["pull_request", pullRequestDelivery(pr, "opened"), "HeadPushed"],
      ["pull_request", pullRequestDelivery(pr, "synchronize"), "HeadPushed"],
      ["pull_request", pullRequestDelivery(pr, "reopened"), "HeadPushed"],
      ["pull_request", edited({ base: { ref: { from: "dev" } } }), "BaseChanged"],
      ["pull_request_review", reviewDelivery(pr, 5, "submitted"), "ReviewSubmitted"],
      ["pull_request_review", reviewDelivery(pr, 5, "dismissed"), "ReviewDismissed"],
      ["push", pushDelivery("Acme/Widgets", "main", M), "MainMoved"],
      ["repository_ruleset", rulesetDelivery("Acme/Widgets", 9, AT, "created"), "RulesChanged"],
      ["repository_ruleset", rulesetDelivery("Acme/Widgets", 9, AT, "deleted"), "RulesChanged"],
    ];

    expect(rows.map(([event, payload]) => kindOf(event, payload))).toEqual(rows.map(([, , kind]) => kind));
  });

  it("ignores unlisted events, unlisted actions and non-conclusions", () => {
    const ignored: [string, unknown][] = [
      ["issues", { action: "opened" }],
      ["pull_request", pullRequestDelivery(pr, "labeled")],
      ["pull_request", edited({ title: { from: "x" } })],
      ["pull_request", edited(undefined)],
      ["pull_request_review", reviewDelivery(pr, 5, "edited")],
      ["check_run", { ...checkRunDelivery(check), action: "created" }],
      ["status", statusDelivery({ ...status, outcome: "pending" })],
      ["pull_request", pullRequestDelivery({ ...pr, end: { merged: true, mergeSha: null, closedAt: AT } })],
    ];

    expect(ignored.map(([event, payload]) => kindOf(event, payload))).toEqual(ignored.map(() => "ignored"));
  });

  // Mutation killed: dropping the default-branch test.
  it("ignores a push to a branch that is not the default", () => {
    expect(kindOf("push", pushDelivery("Acme/Widgets", "feature", M))).toBe("ignored");
    expect(kindOf("push", pushDelivery("Acme/Widgets", "main", M, true))).toBe("ignored");
  });

  it("throws on a malformed payload of a listed kind", () => {
    expect(() => projectDelivery("check_run", { action: "completed" })).toThrow();
  });

  it("declares each kind it can project", () => {
    expect(INGRESS_KINDS.flatMap((row) => row.kinds).sort()).toEqual(
      ["BaseChanged", "CIConcluded", "CIConcluded", "HeadPushed", "MainMoved", "PRClosed", "PRMerged", "ReviewDismissed", "ReviewSubmitted", "RulesChanged"].sort(),
    );
  });
});

describe("projectDelivery privacy and size", () => {
  // Mutation killed: copying `pull_request.title` into the projection.
  it("keeps the title and body of a pull request out of every projection", () => {
    const deliveries = [pullRequestDelivery(pr, "opened"), pullRequestDelivery(merged), pullRequestDelivery(closed), edited({ base: { ref: { from: "dev" } } })];

    const stored = deliveries.map((delivery) => JSON.stringify(projectDelivery("pull_request", withText(delivery as Record<string, unknown>))));

    expect(stored.every((json) => json.includes("Acme") || json.includes("acme"))).toBe(true);
    expect(stored.filter((json) => json.includes(MARKER))).toEqual([]);
  });

  it("keeps every projection far under the payload cap", () => {
    const projected = [projectDelivery("check_run", checkRunDelivery(check)), projectDelivery("pull_request", pullRequestDelivery(merged))];

    expect(projected.map((event) => Buffer.byteLength(JSON.stringify(event)) < MAX_PAYLOAD_BYTES)).toEqual([true, true]);
  });

  it("carries no transport fields, which the answer core owns", () => {
    const projected = projectDelivery("check_run", checkRunDelivery(check));

    expect(projected).not.toHaveProperty("source");
    expect(projected).not.toHaveProperty("deliveryId");
    expect(projected).not.toHaveProperty("observedAt");
  });
});

describe("webhook key equals backstop key", () => {
  const now = "2026-10-17T11:00:00Z";
  const backstop = { source: "backstop", observedAt: now } as const;

  function appendBoth(webhookEvent: unknown, backstopEvent: Parameters<typeof appendEvent>[1]): number {
    const db = openDatabase(":memory:");
    runMigrations(db, [eventLogMigration()]);
    appendEvent(db, { ...(webhookEvent as Parameters<typeof appendEvent>[1]), source: "webhook", deliveryId: "webhook:g1", observedAt: now });
    appendEvent(db, backstopEvent);
    return headSeq(db);
  }

  function webhookOf(event: string, payload: unknown): unknown {
    const projected = projectDelivery(event, payload);
    if (projected === "ignored") throw new Error("expected a projection");
    return projected;
  }

  // Mutation killed: reading `head_sha` from `pull_request.head` in the check-run route.
  it("gives one row for a check run seen by both sources", () => {
    const node = fromBackstopContext("acme/widgets", A, backstopNode(check));
    if (node === undefined) throw new Error("fixture");

    expect(appendBoth(webhookOf("check_run", checkRunDelivery(check)), ciEvent(node, backstop))).toBe(1);
  });

  it("gives one row for a status seen by both sources", () => {
    const node = fromBackstopContext("acme/widgets", A, backstopNode(status));
    if (node === undefined) throw new Error("fixture");

    expect(appendBoth(webhookOf("status", statusDelivery(status)), ciEvent(node, backstop))).toBe(1);
  });

  it("gives one row for a merge, a close, a review and a ruleset seen by both sources", () => {
    const repo = "acme/widgets";
    const mergedBackstop = fromBackstopDonePr(repo, backstopDonePr(merged));
    const closedBackstop = fromBackstopDonePr(repo, backstopDonePr(closed));
    const review = fromBackstopOpenPr(repo, backstopOpenPr({ ...pr, reviews: [{ id: 5, state: "APPROVED" }] })).filter((o) => o.kind === "ReviewSubmitted");
    const rules = fromBackstopRulesets(repo, { 9: AT });

    const counts = [
      appendBoth(webhookOf("pull_request", pullRequestDelivery(merged)), repoEvent(mergedBackstop[0]!, backstop)),
      appendBoth(webhookOf("pull_request", pullRequestDelivery(closed)), repoEvent(closedBackstop[0]!, backstop)),
      appendBoth(webhookOf("pull_request_review", reviewDelivery(pr, 5, "submitted")), repoEvent(review[0]!, backstop)),
      appendBoth(webhookOf("repository_ruleset", rulesetDelivery("Acme/Widgets", 9, AT)), repoEvent(rules[0]!, backstop)),
    ];

    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it("gives one row for a head, a base and a main seen by both sources", () => {
    const open = fromBackstopOpenPr("acme/widgets", backstopOpenPr(pr));
    const head = open.find((o) => o.kind === "HeadPushed")!;
    const base = open.find((o) => o.kind === "BaseChanged")!;

    const counts = [
      appendBoth(webhookOf("pull_request", pullRequestDelivery(pr, "synchronize")), repoEvent(head, backstop)),
      appendBoth(webhookOf("pull_request", edited({ base: { ref: { from: "dev" } } })), repoEvent(base, backstop)),
      appendBoth(webhookOf("push", pushDelivery("Acme/Widgets", "main", M)), repoEvent(fromBackstopMain("acme/widgets", "main", M), backstop)),
    ];

    expect(counts).toEqual([1, 1, 1]);
  });
});
