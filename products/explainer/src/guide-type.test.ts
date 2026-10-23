import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { craftRule, Q_RULES, registryWith } from "./doctrine-fixtures.test-helpers.js";
import { guideForType, writeTypeGuides } from "./guide-type.js";
import { fixedProfile, heuristicProfile, setOf } from "./profile-fixtures.test-helpers.js";
import { loadProfiles } from "./profile-load.js";

const tourRule = craftRule({ id: "story-T1", source: { doc: "story-structure", ref: "T1" }, text: "Tour rule", scope: { layer: "T", types: ["repo-tour"] }, enforcement: ["planner"], stages: ["plan"] });
const argumentRule = craftRule({ id: "story-A1", source: { doc: "story-structure", ref: "A1" }, text: "Argument rule", scope: { layer: "T", types: ["repo-argument"] }, enforcement: ["planner"], stages: ["plan"] });
const gatedRule = craftRule({ id: "dir-G1", text: "Gated threshold", enforcement: ["gate"], stages: ["plan"], check: { kind: "gate", ref: "gate.x", live: true } });
const deps = { registry: registryWith(tourRule, argumentRule, gatedRule), qRules: Q_RULES, profiles: setOf(fixedProfile(), heuristicProfile()) };

describe("guideForType", () => {
  it("gives the tour its fixed chapters and only the rules scoped to it", () => {
    const guide = guideForType("repo-tour", deps);

    expect(guide).toContain("The chapters play in this order every time");
    expect(guide).toContain("**story-T1**: Tour rule");
    expect(guide).not.toContain("story-A1");
  });

  it("gives the argument its heuristic questions in order, then the fallback", () => {
    const guide = guideForType("repo-argument", deps);

    expect(guide).toMatch(/1\. Deciding\? Then \*\*scqa\*\*\.\n2\. Anomaly\?[\s\S]*3\. Long problem\? Then \*\*three-act\*\* \(at 5:00 or longer\)/);
    expect(guide).toContain("5. None of these: **abt**.");
    expect(guide).toContain("**story-A1**: Argument rule");
  });

  it("keeps code-enforced rules and gate thresholds out of the guide", () => {
    const guide = guideForType("repo-tour", deps);

    expect(guide).not.toContain("dir-G1");
    expect(guide).not.toContain("templateMaxShare");
    expect(guide).not.toContain("0.7");
  });

  it("names what must differ from the previous video", () => {
    expect(guideForType("repo-tour", deps)).toContain("Must differ from the previous video: hook-kind, close-kind, function-mix, component-histogram, style-pack.");
  });

  it("writes one guide per profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "guides-"));

    expect(writeTypeGuides(dir, deps)).toEqual(["repo-tour", "repo-argument"]);
    expect(readFileSync(join(dir, "guides", "planner", "repo-tour.md"), "utf8")).toBe(guideForType("repo-tour", deps));
  });
});

describe("the shipped planner guides", () => {
  it.each([...loadProfiles().profiles.keys()])("guides/planner/%s.md matches its profile (regenerate with `explainer guide types`)", (type) => {
    expect(readFileSync(join(DEFAULT_DOCTRINE_DIR, "guides", "planner", `${type}.md`), "utf8")).toBe(guideForType(type));
  });
});
