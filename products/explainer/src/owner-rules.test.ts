import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { paceRows } from "./lint-pace.js";
import { DEFAULT_RULES_PATH, loadRuleRegistry, parseRuleRegistry, type Rule } from "./rules.js";
import { fromSpikeScript } from "./spike-script.js";
import { v4Script } from "./spike-fixtures.test-helpers.js";

const registry = loadRuleRegistry();
const FB_IDS = [1, 2, 3, 4, 5, 6].map((n) => `FB ${n}`);
const tracing = (fb: string): Rule[] => registry.rules.filter((r) => r.owner_support === "for" && r.related.includes(fb));
const OWNER = /^(SQ\d+|TP-\d+)$/;

const hasOpenOwnerOrCheck = (r: Rule): boolean => {
  const l0 = r.l0?.status === "implemented" || (r.l0?.status === "pending" && OWNER.test(r.l0.owner));
  const judge = r.judge?.status === "cited" || (r.judge?.status === "pending" && OWNER.test(r.judge.owner));
  return Boolean(l0 || judge);
};

describe("the owner's six script rules in the Q-registry", () => {
  it("traces each of FB 1 to FB 6 from a rule the owner supports", () => {
    for (const fb of FB_IDS) expect(tracing(fb).map((r) => r.id), fb).not.toEqual([]);
  });

  it("gives every traced rule an implemented check, a cited rubric or a pending owner", () => {
    for (const fb of FB_IDS) for (const r of tracing(fb)) expect(hasOpenOwnerOrCheck(r), `${fb} via ${r.id}`).toBe(true);
  });

  it("keeps the live FB 3 and FB 5 rules on their implemented checks", () => {
    expect(registry.rules.find((r) => r.id === "Q-E7")?.l0).toMatchObject({ status: "implemented", severity: "error" });
    expect(tracing("FB 5").map((r) => r.id)).toEqual(["Q-E9"]);
  });

  it("implements the spine rules Q-E15 to Q-E18 as errors", () => {
    for (const id of ["Q-E15", "Q-E16", "Q-E17", "Q-E18"]) {
      expect(registry.rules.find((r) => r.id === id)?.l0, id).toMatchObject({ status: "implemented", severity: "error", checks: [id] });
    }
  });

  it("cites Q-E15 from the J3 row of the script rubric", () => {
    const rubric = readFileSync(join(dirname(dirname(DEFAULT_RULES_PATH)), "rubrics/l1-script.md"), "utf8");
    const j3 = rubric.split("\n").find((line) => line.startsWith("| J3"));

    expect(j3).toContain("Q-E15");
  });
});

describe("the v4 script against the owner's rules", () => {
  // Mutation: flipping Q-E7's severity to warning in lint-pace.ts fails the FB3 gate assertion.
  it("fails FB 3 as an error naming the overcrowded beats r2-1 and r2-2", () => {
    const { beats, invariants } = fromSpikeScript(v4Script());

    const q7 = paceRows(beats, invariants).find((row) => row.check_id === "Q-E7");

    expect(q7?.severity).toBe("error");
    expect(q7?.pass).toBe(false);
    expect(q7?.detail_beats).toEqual(expect.arrayContaining(["r2-1-jobs", expect.stringMatching(/^r2-2/)]));
  });

  it("accepts a task owner on a pending rule and rejects other owners", () => {
    const rule = { ...registry.rules[0], l0: { severity: "error", status: "pending", owner: "TP-2988", partial: [] } };
    const text = (owner: string) => JSON.stringify({ schema: "rules/v1", rules: [{ ...rule, l0: { ...rule.l0, owner }, judge: undefined }] });

    expect(() => parseRuleRegistry(text("TP-2988"))).not.toThrow();
    expect(() => parseRuleRegistry(text("someone"))).toThrow();
  });
});
