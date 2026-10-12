import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { findingSchema } from "./insights/citations.js";
import { createMinerRegistry } from "./registry.js";

const skillDir = new URL("../skills/session-insights/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8");
const brief = readFileSync(new URL("analyst-brief.md", skillDir), "utf8");

/** Questions that frame or check the analysis rather than feed it. */
const LOOP_COMMANDS = new Set(["seat-generations", "data-quality", "prices", "verify-citations"]);

function insightNames(text: string): string[] {
  return [...text.matchAll(/titan-miner insights ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
}

/** The step number of every insight the skill names, keyed by first mention. */
function stepOfEachInsight(text: string): Map<string, number> {
  const steps = new Map<string, number>();
  for (const section of text.split(/^## Step /m).slice(1)) {
    const step = Number.parseInt(section, 10);
    for (const name of insightNames(section)) if (!steps.has(name)) steps.set(name, step);
  }
  return steps;
}

describe("the session-insights skill", () => {
  it("names only registered miner commands", () => {
    const registered = new Set(createMinerRegistry().list().map((c) => c.name));
    const named = [...insightNames(skill), ...insightNames(brief)];

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !registered.has(`insights.${name}`))).toEqual([]);
  });

  it("checks data quality, then prices, before running any analysis question", () => {
    const steps = stepOfEachInsight(skill);
    const analysis = [...steps].filter(([name]) => !LOOP_COMMANDS.has(name)).map(([, step]) => step);

    expect(analysis.length).toBeGreaterThan(0);
    expect(steps.get("data-quality")!).toBeLessThan(steps.get("prices")!);
    expect(steps.get("prices")!).toBeLessThan(Math.min(...analysis));
  });

  it("verifies the analyst's citations after the analysis questions run", () => {
    const steps = stepOfEachInsight(skill);
    const analysis = [...steps].filter(([name]) => !LOOP_COMMANDS.has(name)).map(([, step]) => step);

    expect(steps.get("verify-citations")!).toBeGreaterThan(Math.max(...analysis));
  });

  it("ships with the package", () => {
    const pkg = createRequire(import.meta.url)("../package.json") as { files: string[] };

    expect(pkg.files).toContain("skills");
  });
});

describe("the analyst brief's example", () => {
  it("parses as findings under the citation contract", () => {
    const example = /```json\n([\s\S]*?)```/.exec(brief)?.[1];
    const findings = JSON.parse(example ?? "null") as unknown[];

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(findingSchema.safeParse(finding).success).toBe(true);
  });
});
