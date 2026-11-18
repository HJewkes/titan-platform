import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TaskRequireSchema } from "./provenance.js";
import { TaskSchema } from "./task.js";

const readFixture = (name: string): unknown =>
  parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const base = {
  id: "AL-1",
  title: "Synthetic task",
  priority: 1,
  status: "open",
  created: "2026-11-01",
  updated: "2026-11-01",
  done_at: null,
};

const parses = (fields: Record<string, unknown>): boolean => TaskSchema.safeParse({ ...base, ...fields }).success;

const fromPr = { from_pr: "acme/widgets#12", from_task: "AL-7" };

describe("task provenance", () => {
  it.each(["SI-1.yml", "SI-2.yml", "PM-actual.yml"])("old task files still parse: %s", (name) => {
    expect(TaskSchema.safeParse(readFixture(name)).success).toBe(true);
  });

  it("keeps every recorded provenance field of a filed task", () => {
    const fields = {
      class: "product",
      serves: "alpha/faster-landing",
      source: "follow-up",
      source_ref: { ...fromPr, head: "a".repeat(40) },
      filed_by: "shepherd",
      rank: "p1",
      done_reason: "shipped",
      blocked_on: "external",
      field_origin: { class: "filed", serves: "owner", source: "audit" },
    };
    expect(TaskSchema.parse({ ...base, ...fields })).toMatchObject(fields);
  });

  it("source owner without an existing ref is refused", () => {
    expect(parses({ source: "owner" })).toBe(false);
    expect(parses({ source: "owner", source_ref: "the owner said so" })).toBe(false);
    expect(parses({ source: "owner", source_ref: "D12" })).toBe(true);
  });

  it("field origin accepts inferred with a heuristic id", () => {
    expect(parses({ class: "upkeep", field_origin: { class: "inferred:census-2026-11-12" } })).toBe(true);
    expect(parses({ field_origin: { class: "inferred:" } })).toBe(false);
    expect(parses({ field_origin: { class: "guessed" } })).toBe(false);
  });

  it("field origin refuses a key that is not a provenance field", () => {
    expect(parses({ field_origin: { title: "filed" } })).toBe(false);
  });

  it.each([
    ["class", "mixed"],
    ["source", "chat"],
    ["rank", "p4"],
    ["done_reason", "abandoned"],
    ["blocked_on", "weather"],
  ])("refuses an unknown %s value", (field, value) => {
    expect(parses({ [field]: value })).toBe(false);
  });

  it("serves takes an outcome id or none", () => {
    expect(parses({ serves: "none" })).toBe(true);
    expect(parses({ serves: "faster-landing" })).toBe(false);
  });

  it("a follow-up or review ref names the PR and the task it came from", () => {
    expect(parses({ source: "review", source_ref: fromPr })).toBe(true);
    expect(parses({ source: "follow-up", source_ref: "acme/widgets#12" })).toBe(false);
    expect(parses({ source: "sweep", source_ref: fromPr })).toBe(false);
  });

  it("a plan ref is path#slice and any ref needs a source", () => {
    expect(parses({ source: "plan", source_ref: "plans/alpha.md#S3" })).toBe(true);
    expect(parses({ source: "plan", source_ref: "plans/alpha.md" })).toBe(false);
    expect(parses({ source_ref: "D12" })).toBe(false);
  });
});

describe("brief task_require", () => {
  it("lists requirable provenance fields once each", () => {
    expect(TaskRequireSchema.safeParse(["class", "source", "serves"]).success).toBe(true);
    expect(TaskRequireSchema.safeParse(["class", "class"]).success).toBe(false);
  });

  it("refuses an unknown task_require entry", () => {
    expect(TaskRequireSchema.safeParse(["field_origin"]).success).toBe(false);
  });
});
