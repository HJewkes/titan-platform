import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import { layout } from "./map-fixtures.test-helpers.js";
import {
  DEFAULT_RULES_PATH,
  checkType,
  loadRuleRegistry,
  parseRuleRegistry,
  resolveRule,
  unclaimedL0Checks,
  unimplementedL0Rules,
  type Rule,
} from "./rules.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const registry = loadRuleRegistry();
const packageRoot = dirname(dirname(DEFAULT_RULES_PATH));
const emittedCheckIds = new Set(runL0(ScriptSchema.parse(scriptWith()), layout, L0_CHECKS).map((row) => row.check_id));

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

describe("the shipped Q-rule registry", () => {
  it("holds the 56 rules: 37 L0, 12 L0+J and 7 judge-only, with Q-F14, Q-F15 and Q-D1 as L0 warnings", () => {
    const byType = (type: string) => registry.rules.filter((r) => checkType(r) === type).length;
    const warnings = registry.rules.filter((r) => r.l0?.severity === "warning").map((r) => r.id);

    expect(registry.rules).toHaveLength(56);
    expect([byType("L0"), byType("L0+J"), byType("J")]).toEqual([37, 12, 7]);
    expect(warnings.sort()).toEqual(["Q-D1", "Q-F14", "Q-F15"]);
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
