import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { BetSchema, FreezeSchema, OutOfScopeSchema, OutcomeSchema } from "./planning.js";
import { TaskSchema } from "./task.js";
import { isAgentVisible } from "./visibility.js";

const outcome = {
  id: "alpha/faster-landing",
  initiative: "alpha",
  statement: "A reviewed change lands the same day",
  measure: "median hours from review to merge",
  state: "active",
  owner_intent: { intent_ref: "D12", quote_ref: "msg:a1b2c3" },
};

const bet = {
  id: "alpha/B1",
  initiative: "alpha",
  week: "2026-W47",
  outcome: "alpha/faster-landing",
  order: 1,
  tasks: ["alpha/AL-1", "alpha/AL-2"],
  prediction: {
    metric: "median_review_to_merge_hours",
    direction: "decrease",
    baseline: 30,
    expected: 12,
    read_by: "2026-11-30",
  },
  state: "selected",
  cites: [{ intent_ref: "alpha/I3", quote_ref: "msg:d4e5f6" }],
};

const freeze = {
  id: "alpha/F1",
  initiative: "alpha",
  tag: "upkeep",
  reason: "Upkeep waits until the landing bet reads",
  end_condition: { kind: "task-done", task: "alpha/AL-2" },
  set_by: "owner",
  intent_ref: "D13",
  quote_ref: "msg:0f9e8d",
};

const outOfScope = {
  id: "alpha/X1",
  initiative: "alpha",
  statement: "No mobile client this quarter",
  intent_ref: "alpha/I4",
  quote_ref: "msg:7c6b5a",
  date: "2026-11-12",
  revisit_when: "the web client has weekly users",
};

const SCHEMAS = [
  { name: "OutcomeSchema", schema: OutcomeSchema, record: outcome },
  { name: "BetSchema", schema: BetSchema, record: bet },
  { name: "FreezeSchema", schema: FreezeSchema, record: freeze },
  { name: "OutOfScopeSchema", schema: OutOfScopeSchema, record: outOfScope },
] as const;

const without = (record: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([field]) => field !== key));

const failedPaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }): string[] =>
  result.error?.issues.map((issue) => issue.path.join(".")) ?? [];

describe("planning records", () => {
  it.each(SCHEMAS)("$name survives a YAML round trip unchanged", ({ schema, record }) => {
    const parsed = schema.parse(record);
    expect(schema.parse(parse(stringify(parsed)))).toEqual(record);
  });

  it.each(SCHEMAS)("$name refuses a record with no id", ({ schema, record }) => {
    expect(failedPaths(schema.safeParse(without(record, "id")))).toContain("id");
  });

  it.each(SCHEMAS)("$name refuses an id filed under another initiative", ({ schema, record }) => {
    expect(failedPaths(schema.safeParse({ ...record, initiative: "beta" }))).toContain("id");
  });

  it.each(SCHEMAS)("$name refuses an unknown key", ({ schema, record }) => {
    expect(schema.safeParse({ ...record, priority: 1 }).success).toBe(false);
  });

  it.each([
    { name: "FreezeSchema", schema: FreezeSchema, record: freeze },
    { name: "OutOfScopeSchema", schema: OutOfScopeSchema, record: outOfScope },
  ])("$name refuses a record with no quote reference", ({ schema, record }) => {
    expect(failedPaths(schema.safeParse(without(record, "quote_ref")))).toContain("quote_ref");
  });

  it("refuses an owner-intent reference whose quote is free text", () => {
    const result = OutOfScopeSchema.safeParse({ ...outOfScope, quote_ref: "the owner said no mobile" });
    expect(failedPaths(result)).toContain("quote_ref");
  });

  it("refuses a cited intent with no quote reference", () => {
    const result = BetSchema.safeParse({ ...bet, cites: [{ intent_ref: "alpha/I3" }] });
    expect(failedPaths(result)).toContain("cites.0.quote_ref");
  });

  it("refuses an outcome intent with no quote reference", () => {
    const result = OutcomeSchema.safeParse({ ...outcome, owner_intent: { intent_ref: "D12" } });
    expect(failedPaths(result)).toContain("owner_intent.quote_ref");
  });

  it("refuses a bet whose prediction has no read-by date", () => {
    const result = BetSchema.safeParse({ ...bet, prediction: without(bet.prediction, "read_by") });
    expect(failedPaths(result)).toContain("prediction.read_by");
  });

  it("refuses a bet that names neither tasks nor a selector", () => {
    expect(BetSchema.safeParse(without(bet, "tasks")).success).toBe(false);
    expect(BetSchema.safeParse({ ...without(bet, "tasks"), selector: "tag:landing" }).success).toBe(true);
  });

  it("refuses a freeze with no end condition, or one of an unknown kind", () => {
    expect(failedPaths(FreezeSchema.safeParse(without(freeze, "end_condition")))).toContain("end_condition");
    expect(FreezeSchema.safeParse({ ...freeze, end_condition: { kind: "never" } }).success).toBe(false);
  });

  it("refuses a freeze that names both a tag and a selector", () => {
    expect(FreezeSchema.safeParse({ ...freeze, selector: "area:infra" }).success).toBe(false);
  });
});

describe("records written before the planning schemas", () => {
  const readFixture = (name: string): unknown =>
    parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

  it.each(["SI-1.yml", "SI-2.yml"])("old task file %s still parses", (name) => {
    expect(TaskSchema.safeParse(readFixture(name)).success).toBe(true);
  });

  it("an old brief with no planning or visibility keys is still read, as owner-only", () => {
    const brief = { title: "Alpha", status: "active", created: "2026-05-12" };
    expect(isAgentVisible({ slug: "alpha", brief })).toBe(false);
  });
});
