import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { betProblem, type BetLookup } from "./provenance.js";
import { TaskSchema } from "./task.js";

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

const knowing = (...ids: string[]): BetLookup => ({ has: async (id) => ids.includes(id) });

describe("task planning fields", () => {
  it("old task files still parse", () => {
    const old = parse(readFileSync(new URL("./fixtures/SI-1.yml", import.meta.url), "utf8"));
    expect(TaskSchema.safeParse(old).success).toBe(true);
  });

  it("keeps bet, fold and owner_steps and lets field_origin cover them", () => {
    const fields = {
      bet: "alpha/B1",
      fold: "alpha/FD2",
      owner_steps: [{ kind: "release", note: "cut the release" }],
      field_origin: { bet: "owner", fold: "filed" },
    };
    expect(TaskSchema.parse({ ...base, ...fields })).toMatchObject(fields);
  });

  it("bet takes a bet id and nothing else", () => {
    expect(parses({ bet: "alpha/B12" })).toBe(true);
    expect(parses({ bet: "B1" })).toBe(false);
    expect(parses({ bet: "alpha/F1" })).toBe(false);
  });

  it("fold accepts independent and a fold id and refuses anything else", () => {
    expect(parses({ fold: "independent" })).toBe(true);
    expect(parses({ fold: "alpha/FD1" })).toBe(true);
    expect(parses({ fold: "alpha/B1" })).toBe(false);
    expect(parses({ fold: "alone" })).toBe(false);
  });

  it("owner_steps allows an empty list and every closed kind", () => {
    expect(parses({ owner_steps: [] })).toBe(true);
    for (const kind of ["release", "restart", "credential", "sitting", "config", "publish"]) {
      expect(parses({ owner_steps: [{ kind, note: "do it" }] })).toBe(true);
    }
  });

  it("owner_steps refuses an unknown kind", () => {
    expect(parses({ owner_steps: [{ kind: "wave", note: "do it" }] })).toBe(false);
  });

  it("owner_steps wants a one-line note", () => {
    expect(parses({ owner_steps: [{ kind: "config", note: "" }] })).toBe(false);
    expect(parses({ owner_steps: [{ kind: "config", note: "a\nb" }] })).toBe(false);
  });
});

describe("bet existence at write", () => {
  it("a task naming an unknown bet id fails validation at write", async () => {
    expect(await betProblem({ bet: "alpha/B9" }, knowing("alpha/B1"))).toBe("Unknown bet id: alpha/B9");
  });

  it("a task naming a known bet passes", async () => {
    expect(await betProblem({ bet: "alpha/B1" }, knowing("alpha/B1"))).toBeNull();
  });

  it("a task with no bet passes without asking the lookup", async () => {
    const lookup: BetLookup = { has: () => Promise.reject(new Error("asked")) };
    expect(await betProblem({}, lookup)).toBeNull();
  });
});
