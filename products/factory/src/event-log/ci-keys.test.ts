import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { ciEvent, ciKey, fromBackstopContext, fromCheckRunDelivery, fromStatusDelivery, utcSeconds, type CiObservation } from "./ci-keys.js";
import { backstopNode, checkRunDelivery, statusDelivery, type CiFact } from "../test-support/a17/ci-shapes.js";
import { appendEvent, eventLogMigration, readEvents } from "./event-log.js";

const SHA = "a".repeat(40);
const OBSERVED = "2026-10-17T12:00:00.000Z";
const CHECK: CiFact = { type: "check", repo: "Acme/Widgets", head: SHA, context: "build", checkRunId: 4242, outcome: "success", at: "2026-10-17T11:59:00Z" };
const STATUS: CiFact = { type: "status", repo: "Acme/Widgets", head: SHA, context: "ci/lint", outcome: "failure", at: "2026-10-17T11:58:00Z" };

function db(): Db {
  const opened = openDatabase(":memory:");
  runMigrations(opened, [eventLogMigration()]);
  return opened;
}

const need = (value: CiObservation | undefined): CiObservation => {
  if (value === undefined) throw new Error("expected an occurrence");
  return value;
};

describe("CIConcluded occurrence keys", () => {
  it("derives the check-run key with a lowercased repo from the webhook and the GraphQL shape alike", () => {
    const expected = `v1|CIConcluded|acme/widgets|check|${SHA}|4242|success|2026-10-17T11:59:00Z`;

    expect(ciKey(need(fromCheckRunDelivery(checkRunDelivery(CHECK))))).toBe(expected);
    expect(ciKey(need(fromBackstopContext("Acme/Widgets", SHA, backstopNode(CHECK))))).toBe(expected);
  });

  it("derives the status key from the context, state and created_at in both shapes", () => {
    const expected = `v1|CIConcluded|acme/widgets|status|${SHA}|ci/lint|failure|2026-10-17T11:58:00Z`;

    expect(ciKey(need(fromStatusDelivery(statusDelivery(STATUS))))).toBe(expected);
    expect(ciKey(need(fromBackstopContext("acme/widgets", SHA, backstopNode(STATUS))))).toBe(expected);
  });

  it.each([
    ["a webhook check run", CHECK, (f: CiFact) => fromCheckRunDelivery(checkRunDelivery(f))],
    ["a webhook status", STATUS, (f: CiFact) => fromStatusDelivery(statusDelivery(f))],
  ])("stores one row when %s and the backstop report the same occurrence", (_name, fact, viaWebhook) => {
    const log = db();
    const webhook = appendEvent(log, ciEvent(need(viaWebhook(fact)), { source: "webhook", observedAt: OBSERVED, deliveryId: "d1" }));
    const backstop = appendEvent(log, ciEvent(need(fromBackstopContext(fact.repo, fact.head, backstopNode(fact))), { source: "backstop", observedAt: OBSERVED }));

    expect(webhook.inserted).toBe(true);
    expect(backstop).toEqual({ inserted: false, seq: webhook.seq, by: "occurrence" });
    expect(readEvents(log, { subject: `acme/widgets@${SHA}`, sinceSeq: 0 })).toHaveLength(1);
  });

  it("normalises an offset or fractional stamp to UTC seconds", () => {
    expect(utcSeconds("2026-10-17T13:59:00.250+02:00")).toBe("2026-10-17T11:59:00Z");
    expect(() => utcSeconds("yesterday")).toThrow(RangeError);
  });

  it("emits nothing for a pending status, a running check or a delivery that is not a completion", () => {
    const pending: CiFact = { ...STATUS, outcome: "pending" };
    const running = { __typename: "CheckRun", databaseId: 1, name: "build", status: "IN_PROGRESS", conclusion: null, completedAt: null } as const;
    const created = { ...checkRunDelivery(CHECK), action: "created" };

    expect(fromStatusDelivery(statusDelivery(pending))).toBeUndefined();
    expect(fromBackstopContext("o/r", SHA, backstopNode(pending))).toBeUndefined();
    expect(fromBackstopContext("o/r", SHA, running)).toBeUndefined();
    expect(fromCheckRunDelivery(created)).toBeUndefined();
  });

  it("keeps the delivery id namespaced and leaves a backstop row without one", () => {
    const observation = need(fromStatusDelivery(statusDelivery(STATUS)));

    expect(ciEvent(observation, { source: "webhook", observedAt: OBSERVED, deliveryId: "d1" }).deliveryId).toBe("webhook:d1");
    expect(ciEvent(observation, { source: "backstop", observedAt: OBSERVED }).deliveryId).toBeUndefined();
  });
});
