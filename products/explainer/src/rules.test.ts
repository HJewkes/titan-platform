import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import { layout } from "./map-fixtures.test-helpers.js";
import {
  DEFAULT_RULES_PATH,
  checkType,
  checksScopedAway,
  loadRuleRegistry,
  parseRuleRegistry,
  resolveRule,
  unclaimedL0Checks,
  unimplementedL0Rules,
  type Rule,
} from "./rules.js";
import { ScriptSchema } from "./script-schema.js";
import { parseSpine } from "./spine-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const registry = loadRuleRegistry();
const packageRoot = dirname(dirname(DEFAULT_RULES_PATH));
// The spine lints emit only for a run that has a spine, so the registry cross-check supplies the pilot one.
const pilotSpine = parseSpine(readFileSync(new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url), "utf8"));
const emittedBy = (profile: string) => runL0(ScriptSchema.parse({ ...scriptWith(), profile }), layout, L0_CHECKS, undefined, pilotSpine).map((row) => row.check_id);
const emittedCheckIds = new Set([...emittedBy("repo-tour"), ...emittedBy("daily-overview")]);

// TP-4470's script preflight rows, rolled out on daily-overview first.
const SCRIPT_PREFLIGHT_IDS = ["Q-D14", "Q-D15", "Q-D16", "Q-D17", "Q-D18", "Q-D19"];

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: "Q-V1",
  rule: "No spoken process narration",
  fields: ["beats.spoken"],
  aliases: [],
  related: [],
  rubric_dims: [],
  owner_support: "none",
  l0: { severity: "error", status: "pending", owner: "SQ3", partial: [] },
  ...overrides,
});
const registryText = (...rules: Rule[]): string => stringify({ schema: "rules/v1", rules });

const KNOWN = { structures: new Set(["design-journey"]), profiles: new Set(["daily-overview", "repo-tour"]) };

describe("L0 rules scoped by structure", () => {
  const scoped = (structures: string[]): string =>
    registryText(rule({ l0: { severity: "error", status: "implemented", checks: ["Q-V1"], structures } }));

  it("accepts a structures list that names registered structures", () => {
    const parsed = parseRuleRegistry(scoped(["design-journey"]), KNOWN);

    expect(parsed.rules[0]?.l0).toMatchObject({ structures: ["design-journey"] });
  });

  // Mutation: skipping the registered-structure check lets the typo through and fails this.
  it("refuses a structure id the structure registry does not hold", () => {
    expect(() => parseRuleRegistry(scoped(["design-jorney"]), KNOWN)).toThrow(/Q-V1: unknown structure design-jorney/);
  });

  // Mutation: skipping the registered-profile check lets the typo through and fails this.
  it("refuses an exempt profile the type registry does not hold", () => {
    const text = registryText(rule({ l0: { severity: "error", status: "implemented", checks: ["Q-V1"], except_profiles: ["daily-overveiw"] } }));

    expect(() => parseRuleRegistry(text, KNOWN)).toThrow(/Q-V1: unknown profile daily-overveiw/);
  });

  it("keeps a rule exempting one profile on a structure registered after it", () => {
    const text = registryText(rule({ l0: { severity: "error", status: "implemented", checks: ["Q-V1"], except_profiles: ["daily-overview"] } }));
    const parsed = parseRuleRegistry(text, KNOWN);

    expect(checksScopedAway(parsed, { structure: "brand-new-structure", profile: "repo-tour" }).size).toBe(0);
    expect([...checksScopedAway(parsed, { structure: "brand-new-structure", profile: "daily-overview" })]).toEqual(["Q-V1"]);
  });

  it("scopes Q-W8, Q-F3, Q-F4 and Q-F5 to design-journey in the shipped registry", () => {
    const outside = checksScopedAway(registry, { structure: "scqa", profile: "pr-overview" });

    expect(["Q-W8", "Q-F3", "Q-F4", "Q-F5", "Q-E15"].every((id) => outside.has(id))).toBe(true);
    expect([...checksScopedAway(registry, { profile: "pr-overview" })].sort()).toEqual(SCRIPT_PREFLIGHT_IDS);
    expect(SCRIPT_PREFLIGHT_IDS.filter((id) => checksScopedAway(registry, { profile: "daily-overview" }).has(id))).toEqual([]);
  });
});

describe("the shipped Q-rule registry", () => {
  it("holds the 82 rules: 62 L0, 13 L0+J and 7 judge-only, with Q-F14, Q-F15, Q-D1 and the pace rates as L0 warnings", () => {
    const byType = (type: string) => registry.rules.filter((r) => checkType(r) === type).length;
    const warnings = registry.rules.filter((r) => r.l0?.severity === "warning").map((r) => r.id);

    expect(registry.rules).toHaveLength(82);
    expect([byType("L0"), byType("L0+J"), byType("J")]).toEqual([62, 13, 7]);
    expect(warnings.sort()).toEqual(["Q-D1", "Q-E10", "Q-E12", "Q-E13", "Q-E14", "Q-E19", "Q-E8", "Q-F14", "Q-F15", "Q-V11"]);
  });

  it("resolves every phase-1 alias to the one rule that absorbed it", () => {
    expect(resolveRule(registry, "X1")?.id).toBe("Q-V1");
    expect(resolveRule(registry, "TC17")?.id).toBe("Q-W9");
    expect(resolveRule(registry, "SA12")?.id).toBe("Q-E3");
    for (const r of registry.rules) for (const alias of r.aliases) expect(resolveRule(registry, alias)).toBe(r);
  });

  it("gives every L0 rule a registered implementation or a pending owner slice", () => {
    expect(unimplementedL0Rules(registry, emittedCheckIds)).toEqual([]);
    expect(resolveRule(registry, "Q-D3")?.l0).toMatchObject({ status: "implemented", checks: ["map:hand-framing"] });
  });

  it("marks implemented every Q-rule whose check id the registered L0 checks emit", () => {
    expect(unclaimedL0Checks(registry, emittedCheckIds)).toEqual([]);
  });

  it("has every judge rule cited by a rubric file that names it, or pending on its owner slice", () => {
    for (const r of registry.rules.filter((each) => each.judge?.status === "cited")) {
      const rubric = join(packageRoot, r.judge?.status === "cited" ? r.judge.rubric : "");
      expect(existsSync(rubric), `${r.id} cites ${rubric}`).toBe(true);
      expect(readFileSync(rubric, "utf8")).toContain(r.id);
    }
    expect(resolveRule(registry, "Q-E6")?.judge).toEqual({ layer: "L1", status: "cited", rubric: "rubrics/l1-cold.md" });
  });

  it("reads only fields script/v1 defines", () => {
    const shape = ScriptSchema.shape;
    const children: Record<string, readonly string[]> = {
      video: Object.keys(shape.video.shape),
      beats: Object.keys(shape.beats.element.shape),
      chapters: Object.keys(shape.chapters.element.shape),
    };
    for (const field of registry.rules.flatMap((r) => r.fields)) {
      const [root = "", child] = field.split(".");
      expect(Object.keys(shape), field).toContain(root);
      if (child) expect(children[root], field).toContain(child);
    }
  });
});

describe("registry validation", () => {
  it("reports an L0 rule claimed as implemented whose check id no registered check emits", () => {
    const claimed = parseRuleRegistry(registryText(rule({ l0: { severity: "error", status: "implemented", checks: ["voice:process-narration"] } })));

    expect(unimplementedL0Rules(claimed, emittedCheckIds)).toEqual(["Q-V1"]);
  });

  it("reports a pending rule whose partial check id does not exist", () => {
    const claimed = parseRuleRegistry(registryText(rule({ l0: { severity: "error", status: "pending", owner: "SQ5", partial: ["map:no-such-lint"] } })));

    expect(unimplementedL0Rules(claimed, emittedCheckIds)).toEqual(["Q-V1"]);
  });

  it("reports an emitted Q-rule check id whose rule is still pending, or that names no rule", () => {
    const pending = parseRuleRegistry(registryText(rule()));
    const claimed = parseRuleRegistry(registryText(rule({ l0: { severity: "error", status: "implemented", checks: ["Q-V1"] } })));

    expect(unclaimedL0Checks(pending, new Set(["Q-V1", "map:level-step"]))).toEqual(["Q-V1"]);
    expect(unclaimedL0Checks(claimed, new Set(["Q-V1", "Q-V2"]))).toEqual(["Q-V2"]);
  });

  it("rejects a pending L0 rule with no owning slice", () => {
    const text = registryText(rule()).replace("owner: SQ3", "owner: someone");

    expect(() => parseRuleRegistry(text)).toThrow(/owning slice/);
  });

  it("rejects an alias that two rules claim, and an alias that shadows a rule id", () => {
    const twice = registryText(rule({ aliases: ["X1"] }), rule({ id: "Q-V6", aliases: ["X1"] }));
    const shadow = registryText(rule(), rule({ id: "Q-V6", aliases: ["Q-V1"] }));

    expect(() => parseRuleRegistry(twice)).toThrow(/X1 already names Q-V1/);
    expect(() => parseRuleRegistry(shadow)).toThrow(/Q-V1 already names Q-V1/);
  });

  it("rejects a rule with neither an l0 nor a judge check", () => {
    const bare = { ...rule(), l0: undefined };

    expect(() => parseRuleRegistry(registryText(bare))).toThrow(/l0 check, a judge check, or both/);
  });
});
