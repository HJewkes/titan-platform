import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEATS } from "./beat-fixtures.test-helpers.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { craftRule, Q_RULES, registryWith } from "./doctrine-fixtures.test-helpers.js";
import { guidePlan } from "./guide-plan.js";
import { guideForType, writeTypeGuides } from "./guide-type.js";
import { fixedProfile, heuristicProfile, setOf } from "./profile-fixtures.test-helpers.js";
import { loadProfiles } from "./profile-load.js";

const tourRule = craftRule({ id: "story-T1", source: { doc: "story-structure", ref: "T1" }, text: "Tour rule", scope: { layer: "T", types: ["repo-tour"] }, enforcement: ["planner"], stages: ["plan"] });
const argumentRule = craftRule({ id: "story-A1", source: { doc: "story-structure", ref: "A1" }, text: "Argument rule", scope: { layer: "T", types: ["repo-argument"] }, enforcement: ["planner"], stages: ["plan"] });
const abtRule = craftRule({ id: "story-S1", source: { doc: "story-structure", ref: "S1" }, text: "ABT rule", scope: { layer: "T", structures: ["abt"] }, enforcement: ["planner"], stages: ["plan"] });
const gatedRule = craftRule({ id: "dir-G1", text: "Gated threshold", enforcement: ["gate"], stages: ["plan"], check: { kind: "gate", ref: "gate.x", live: true } });
const fixedStructure = fixedProfile().structure;
const deps = { registry: registryWith(tourRule, argumentRule, abtRule, gatedRule), qRules: Q_RULES, profiles: setOf(fixedProfile(), heuristicProfile()), beats: BEATS };

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

  it("lists each structure the profile may pick, with its spine and the rules it brings", () => {
    const argument = guideForType("repo-argument", deps);
    const abtEntry = argument.slice(argument.indexOf("### abt"));

    expect(argument).toMatch(/### scqa\n\nscqa summary\. \(scqa source\)\n\nSpine sections: 1\. Only\./);
    expect(abtEntry).toMatch(/^### abt[^#]*\*\*story-S1\*\*: ABT rule/);
    expect(argument.match(/story-S1/g)).toHaveLength(1);
    expect(guideForType("repo-tour", deps)).not.toContain("story-S1");
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

  it("indexes each beat its blocks allow, once, with its role and duration range", () => {
    const guide = guideForType("repo-tour", deps);

    expect(guide).toContain("## Beats\n\n- **hook** (open, 5-20 s): hook summary.\n\n## Rules");
  });

  it("lists each bound beat system once, with its steps, and names it under each structure it plays in", () => {
    const tour = fixedProfile({ structure: { ...fixedStructure, systems: [{ system: "hook-close", macro: "scqa-c4" }, { system: "walk-first", macro: "scqa-c4", blocks: ["map"] }] } });
    const guide = guideForType("repo-tour", { ...deps, profiles: setOf(tour) });

    expect(guide).toContain("Beat systems: **hook-close** over every block; **walk-first** inside map.");
    expect(guide).toContain("### hook-close\n\nhook-close summary. (hook-close source)\n\n1. hook: Open.\n2. code-walk (optional): Walk.\n3. hook: Close.");
    expect(guide.match(/### walk-first/g)).toHaveLength(1);
    expect(guideForType("repo-tour", deps)).not.toContain("## Beat systems");
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

describe("owner-FB1, the journey rule", () => {
  it("reaches the design-journey planner guide and no type guide that never picks design-journey", () => {
    const shipped = loadProfiles();

    expect(guidePlan("plan")).toContain("**owner-FB1**");
    expect([...shipped.profiles.keys()].filter((type) => guideForType(type, { profiles: shipped }).includes("owner-FB1"))).toEqual([]);
  });
});
