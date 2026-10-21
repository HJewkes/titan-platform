import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agreement, kindCensus, type CensusRow, type DuplicateLine } from "./agreement.js";

const HEAD = "a".repeat(40);
const SUBJECT = `example-org/widgets@${HEAD}`;
const AT = "2026-10-17T12:00:00.000Z";
const later = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();
const INTERVAL = 300_000;
const INGRESS_KINDS = new Set(["CIConcluded", "HeadPushed", "ReviewSubmitted"]);

const row = (seq: number, over: Partial<CensusRow> = {}): CensusRow => ({
  seq,
  source: "webhook",
  kind: "CIConcluded",
  subject: SUBJECT,
  keys: { type: "check", context: "build", outcome: "success", checkRunId: 101 },
  occurrenceKey: `v1|CIConcluded|example-org/widgets|check|${HEAD}|101|success|2026-10-17T11:59:00Z`,
  observedAt: AT,
  ...over,
});
const confirmed = (seq: number, at = later(INTERVAL), by: DuplicateLine["by"] = "occurrence"): DuplicateLine => ({ seq, by, at });
const options = { ingressKinds: INGRESS_KINDS, withinMs: INTERVAL, until: later(10 * INTERVAL) };

describe("agreement (F11 clock 2, TP-3102 §3(b))", () => {
  it("matches a webhook row the backstop re-observed within one interval, and calls one it never did a backstop miss", () => {
    const rows = [row(1), row(2, { occurrenceKey: "v1|CIConcluded|other", keys: { type: "status", context: "lint", outcome: "success" } })];

    const result = agreement(rows, [confirmed(1)], options);

    expect(result.matched).toEqual([1]);
    expect(result.webhookOnly).toEqual([2]);
  });

  it("does not count a confirmation that came later than the window, or one that matched only the delivery id", () => {
    const rows = [row(1), row(2, { occurrenceKey: "v1|CIConcluded|other", keys: { type: "status", context: "lint", outcome: "success" } })];

    const result = agreement(rows, [confirmed(1, later(INTERVAL + 1)), confirmed(2, later(1), "delivery")], options);

    expect(result.matched).toEqual([]);
    expect(result.webhookOnly).toEqual([1, 2]);
  });

  it("counts a transition the backstop found unchanged as matched", () => {
    const head = row(3, { kind: "HeadPushed", subject: "example-org/widgets#1", keys: { value: HEAD }, occurrenceKey: `v1|HeadPushed|x|after:0` });

    expect(agreement([head], [confirmed(3, later(1), "unchanged")], options).matched).toEqual([3]);
  });

  it("holds a webhook row whose interval has not elapsed by the window's end as pending, not a miss", () => {
    const result = agreement([row(1, { observedAt: later(9.5 * INTERVAL) })], [], options);

    expect(result).toMatchObject({ webhookOnly: [], pending: [1] });
  });

  it("calls a backstop row of an ingress kind a dropped delivery, and ignores a kind the ingress never writes", () => {
    const dropped = row(4, { source: "backstop" });
    const ruleset = row(5, { source: "backstop", kind: "RulesChanged", subject: "example-org/widgets", keys: { rulesetId: 7, updatedAt: AT }, occurrenceKey: "v1|RulesChanged|x" });

    expect(agreement([dropped, ruleset], [], options).backstopOnly).toEqual([4]);
  });

  it("pairs a webhook row and a backstop row of one fact under different keys as divergent, not as a miss and a drop", () => {
    const webhook = row(1);
    const backstop = row(2, { source: "backstop", keys: { type: "check", context: "build", outcome: "success" }, occurrenceKey: "v1|CIConcluded|missing-id" });

    const result = agreement([webhook, backstop], [], options);

    expect(result).toEqual({ matched: [], webhookOnly: [], backstopOnly: [], pending: [], divergentKeys: [{ webhook: 1, backstop: 2 }] });
  });
});

describe("kindCensus (F11 clock 1, TP-3102 §3(b))", () => {
  it("names a declared kind no backstop row carries as missing", () => {
    const rows = [row(1, { source: "backstop" })];

    expect(kindCensus(rows, ["CIConcluded", "HeadPushed"])).toEqual({ seen: ["CIConcluded"], missing: ["HeadPushed"] });
  });

  it("does not let a stray webhook row in a polling window count a kind as seen", () => {
    const rows = [row(1, { source: "backstop" }), row(2, { kind: "HeadPushed", subject: "example-org/widgets#1", keys: { value: HEAD } })];

    expect(kindCensus(rows, ["CIConcluded", "HeadPushed"])).toEqual({ seen: ["CIConcluded"], missing: ["HeadPushed"] });
  });
});

const SRC = fileURLToPath(new URL("..", import.meta.url));
const AGREEMENT_IMPORT = /\bfrom\s+["'][^"']*event-log\/agreement(?:\.js)?["']|\bfrom\s+["']\.\/agreement(?:\.js)?["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Pure: I7 lets the log's own module and tests read the comparator; anything else would be a consumer of the log. */
function mayImportAgreement(path: string): boolean {
  return path.startsWith("event-log/") || path.endsWith(".test.ts");
}

describe("agreement.ts consumers (I7)", () => {
  it("is imported by nothing outside event-log/ and tests", () => {
    const importers = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !mayImportAgreement(path))
      .filter((path) => AGREEMENT_IMPORT.test(readFileSync(join(SRC, path), "utf8")));

    expect(importers).toEqual([]);
  });

  it("reads an import from a service file as a consumer, and exempts the log and tests", () => {
    expect(AGREEMENT_IMPORT.test('import { agreement } from "../event-log/agreement.js";')).toBe(true);
    expect(AGREEMENT_IMPORT.test('import { agreement } from "./agreement.js";')).toBe(true);
    expect(["serve.ts", "test-support/a17/feed.ts", "reconciler/service.ts"].filter(mayImportAgreement)).toEqual([]);
    expect(["event-log/agreement.ts", "test-support/a17/parity.test.ts"].every(mayImportAgreement)).toBe(true);
  });

  it("scans a tree that holds this test's own import", () => {
    const paths = sourceFiles(SRC).map((path) => relative(SRC, path).split(sep).join("/"));

    expect(paths.filter((path) => AGREEMENT_IMPORT.test(readFileSync(join(SRC, path), "utf8")))).toContain("event-log/agreement.test.ts");
  });
});
