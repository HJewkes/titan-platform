import { describe, expect, it } from "vitest";
import { ratePeaks, type RateRecord } from "../github-api/rate-sample.js";
import { DUE_CHECK_TICK_MS } from "../github-sources/schedule.js";
import { INGRESS_KINDS } from "../ingress/kinds.js";
import { agreement, kindCensus, type CensusRow } from "./agreement.js";
import { F11_KINDS, F11_WITHIN_MS, f11Markdown, f11Report, type F11Input } from "./f11-report.js";
import { f11Window } from "./f11-window.js";

const engines = { kindCensus, agreement, ratePeaks };
const window = f11Window("2026-10-20T00:00:00Z", "2026-10-22T00:00:00Z");
const RESET = Date.parse("2026-10-21T11:00:00Z") / 1000;

function row(seq: number, overrides: Partial<CensusRow> = {}): CensusRow {
  return { seq, source: "webhook", kind: "HeadPushed", subject: `acme/widget#${seq}`, keys: { pr: seq }, occurrenceKey: `k${seq}`, observedAt: "2026-10-21T10:00:00.000Z", ...overrides };
}

/** A `journalctl -o short-iso` record of a daemon line. */
function line(stamp: string, message: string, fields?: Record<string, unknown>): string {
  return `${stamp} host titan-factory[42]: [info] ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`;
}

function report(overrides: Partial<F11Input>) {
  return f11Report({ clock: "webhook", window, rows: [], log: "", rate: [], ...overrides }, engines);
}

function sample(at: string, used: number, limit = 5000): RateRecord {
  return { at, core: { used, limit, reset: RESET }, graphql: { used: 0, limit: 5000, reset: RESET } };
}

describe("f11Report constants", () => {
  it("declares every kind the ingress projects", () => {
    expect([...F11_KINDS].sort()).toEqual([...new Set(INGRESS_KINDS.flatMap((entry) => entry.kinds))].sort());
  });

  it("lets a re-observation come one default backstop interval plus one due-check tick late", () => {
    expect(F11_WITHIN_MS).toBe(300_000 + DUE_CHECK_TICK_MS);
  });
});

describe("f11Report clock 1 (polling)", () => {
  it("runs the kind census over the backstop's rows and no agreement", () => {
    const rows = [row(1, { source: "backstop", kind: "CIConcluded" }), row(2, { kind: "HeadPushed" })];

    const result = report({ clock: "polling", rows });

    expect(result.census?.seen).toEqual(["CIConcluded"]);
    expect(result.census?.missing).toContain("HeadPushed");
    expect(result.agreement).toBeUndefined();
  });
});

describe("f11Report clock 2 (webhook)", () => {
  it("matches a webhook row by a timestamped reconciler.confirmed line, and not by a delivery retry or an unknown answer", () => {
    const rows = [row(1), row(2), row(3)];
    const log = [
      line("2026-10-21T10:03:00+0000", "reconciler.confirmed", { repo: "acme/widget", kind: "HeadPushed", seq: 1, by: "occurrence" }),
      line("2026-10-21T10:03:00+0000", "reconciler.confirmed", { repo: "acme/widget", kind: "HeadPushed", seq: 2, by: "delivery" }),
      line("2026-10-21T10:03:00+0000", "reconciler.confirmed", { repo: "acme/widget", kind: "HeadPushed", seq: 3, by: "inserted" }),
    ].join("\n");

    const result = report({ rows, log });

    expect(result.agreement).toMatchObject({ matched: [1], webhookOnly: [2, 3], pending: [] });
    expect(result.census).toBeUndefined();
  });

  it("takes withinMs from the input, so a confirm later than it leaves the row webhookOnly", () => {
    const log = line("2026-10-21T10:03:00+0000", "reconciler.confirmed", { seq: 1, by: "occurrence" });

    expect(report({ rows: [row(1)], log, withinMs: 60_000 }).agreement?.webhookOnly).toEqual([1]);
  });

  it("ignores log lines outside [since, until) and counts untimed ones instead of placing them", () => {
    const log = [
      line("2026-10-22T00:00:00+0000", "reconciler.confirmed", { seq: 1, by: "occurrence" }),
      line("2026-10-19T23:59:59+0000", "reconciler.disagree", { class: "stale-read" }),
      line("2026-10-20T00:00:00+0000", "reconciler.disagree", { class: "field-parity" }),
      line("2026-10-22T01:00:00+0200", "reconciler.disagree", { class: "unconfirmed" }),
      "[info] reconciler.confirmed " + JSON.stringify({ seq: 1, by: "occurrence" }),
    ].join("\n");

    const result = report({ rows: [row(1, { observedAt: "2026-10-21T23:58:00.000Z" })], log });

    expect(result.agreement?.pending).toEqual([1]);
    expect(result.epochs.disagree).toMatchObject({ "stale-read": 0, "field-parity": 1, unconfirmed: 1 });
    expect(result.log).toMatchObject({ lines: 2, untimed: 1, confirmed: 0 });
  });
});

describe("f11Report epoch stability and re-runs", () => {
  it("counts each disagree class, zero ones included, and bare head-regression lines", () => {
    const log = [
      line("2026-10-21T10:00:00+0000", "reconciler.disagree", { repo: "acme/widget", class: "stale-read", subject: "acme/widget#1" }),
      line("2026-10-21T10:01:00+0000", "reconciler.disagree", { repo: "acme/widget", class: "stale-read", subject: "acme/widget#2" }),
      line("2026-10-21T10:02:00+0000", "reconciler.disagree", { repo: "acme/widget", class: "novel" }),
      "2026-10-21T10:04:00+0000 host titan-factory[42]: head-regression repo=acme/widget pr=7 held=bbb read=aaa",
    ].join("\n");

    const { epochs } = report({ log });

    expect(epochs).toEqual({ disagree: { "stale-read": 2, "field-parity": 0, "main-ancestry-lost": 0, unconfirmed: 0, novel: 1 }, headRegression: 1 });
  });

  it("lists each (sha, check) seen twice with its distinct check run ids, skipping statuses and single runs", () => {
    const check = (seq: number, context: string, checkRunId: number, subject = "acme/widget@abc") => row(seq, { kind: "CIConcluded", subject, keys: { type: "check", context, outcome: "success", checkRunId } });
    const rows = [
      check(1, "build", 11),
      check(2, "build", 11),
      check(3, "lint", 21),
      check(4, "lint", 22),
      check(5, "test", 31),
      check(6, "build", 12, "acme/widget@def"),
      row(7, { kind: "CIConcluded", subject: "acme/widget@abc", keys: { type: "status", context: "deploy", outcome: "success" } }),
      row(8, { kind: "CIConcluded", subject: "acme/widget@abc", keys: { type: "status", context: "deploy", outcome: "failure" } }),
    ];

    expect(report({ rows }).checkRuns).toEqual([
      { subject: "acme/widget@abc", name: "build", rows: 2, checkRunIds: [11] },
      { subject: "acme/widget@abc", name: "lint", rows: 2, checkRunIds: [21, 22] },
    ]);
  });
});

describe("f11Report peaks", () => {
  const peak = (stamp: string, used: number, resource = "core") =>
    line(stamp, "github-api.peak", { identity: "bot", resource, used, limit: 5000, pct: Math.round(used / 50), reset: new Date(RESET * 1000).toISOString() });

  it("keeps the bot's highest window from serve's peak lines and the sampled side's from its records in the window", () => {
    const log = [peak("2026-10-21T10:00:00+0000", 1400), peak("2026-10-21T11:00:00+0000", 900), peak("2026-10-21T11:00:00+0000", 10, "graphql")].join("\n");
    const rate = [sample("2026-10-21T10:00:00.000Z", 2400), sample("2026-10-21T10:30:00.000Z", 2600), sample("2026-10-22T00:00:00.000Z", 4900)];

    const { peaks } = report({ log, rate });

    expect(peaks).toEqual([
      { identity: "bot", resource: "core", used: 1400, limit: 5000, pct: 28, reset: "2026-10-21T11:00:00.000Z", underBound: true },
      { identity: "bot", resource: "graphql", used: 10, limit: 5000, pct: 0, reset: "2026-10-21T11:00:00.000Z", underBound: true },
      { identity: "hjewkes", resource: "core", used: 2600, limit: 5000, pct: 52, reset: "2026-10-21T11:00:00.000Z", underBound: false },
      { identity: "hjewkes", resource: "graphql", used: 0, limit: 5000, pct: 0, reset: "2026-10-21T11:00:00.000Z", underBound: true },
    ]);
  });

  it("holds exactly half of the limit over the bound", () => {
    expect(report({ rate: [sample("2026-10-21T10:00:00.000Z", 2500)] }).peaks[0]?.underBound).toBe(false);
    expect(report({ rate: [sample("2026-10-21T10:00:00.000Z", 2499)] }).peaks[0]?.underBound).toBe(true);
  });

  it("compares windows by share of their limit, not by raw use", () => {
    const rate = [sample("2026-10-21T10:00:00.000Z", 1000, 2000), { ...sample("2026-10-21T12:00:00.000Z", 1500), core: { used: 1500, limit: 5000, reset: RESET + 3600 } }];

    expect(report({ rate }).peaks[0]).toMatchObject({ used: 1000, limit: 2000, pct: 50 });
  });
});

describe("f11Report log counts and markdown", () => {
  it("counts cost lines and webhook deliveries, redeliveries apart", () => {
    const log = [
      line("2026-10-21T10:00:00+0000", "reconciler.cost", { repo: "acme/widget" }),
      line("2026-10-21T10:00:01+0000", "webhook delivery stored", { delivery: "d1", seq: 1, inserted: true }),
      line("2026-10-21T10:00:02+0000", "webhook delivery stored", { delivery: "d1", seq: 1, inserted: false }),
      "2026-10-21T10:00:03+0000 host systemd[1]: Started something.",
    ].join("\n");

    expect(report({ log }).log).toEqual({ lines: 3, untimed: 0, confirmed: 0, costLines: 1, deliveries: 2, redeliveries: 1 });
  });

  it("renders the clock's own fields, the epoch counts and each peak against the bound", () => {
    const polling = f11Markdown(report({ clock: "polling", rows: [row(1, { source: "backstop" })], rate: [sample("2026-10-21T10:00:00.000Z", 2600)] }));
    const webhook = f11Markdown(report({ rows: [row(4)] }));

    expect(polling).toContain("## F11 polling clock, 2026-10-20T00:00:00.000Z to 2026-10-22T00:00:00.000Z");
    expect(polling).toContain("- seen kinds: HeadPushed");
    expect(polling).toContain("- peak hjewkes core: 2600/5000 (52%) AT OR OVER 50%");
    expect(polling).toContain("stale-read 0, field-parity 0");
    expect(webhook).toContain("- webhookOnly: 4");
    expect(webhook).toContain("- divergentKeys: none");
  });
});
