import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findingSchema } from "./insights/citations.js";
import { createMinerRegistry } from "./registry.js";

const skillDir = new URL("../skills/session-insights/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8");
const brief = readFileSync(new URL("analyst-brief.md", skillDir), "utf8");

/** Questions that frame or check the analysis rather than feed it. */
const LOOP_COMMANDS = new Set(["seat-generations", "data-quality", "prices", "verify-citations"]);

function stepText(text: string, step: number): string {
  return text.split(/^## Step /m).find((section) => Number.parseInt(section, 10) === step) ?? "";
}

function briefExample(): unknown[] {
  const example = /```json\n([\s\S]*?)```/.exec(brief)?.[1];
  return z.array(z.unknown()).parse(JSON.parse(example ?? "null"));
}

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

  it("scores every proposed lever on verdict-to-merge, open MERGE PRs and requests per finished agent", () => {
    const report = stepText(skill, 7);

    expect(report).toContain("titan-miner insights blocked-flow --split-at");
    expect(report).toContain("/verdictToMerge/rows");
    expect(report).toContain("/openHoldingMerge/rows");
    expect(report).toContain("requestsPerFinished");
  });

  it("names Q13 with a before window as every lever's guardrail", () => {
    const report = stepText(skill, 7);

    expect(report).toMatch(/titan-miner insights quality-guardrails .*--before-since .*--before-until/);
  });

  it("ships with the package", () => {
    const pkg = z.object({ files: z.array(z.string()) }).parse(createRequire(import.meta.url)("../package.json"));

    expect(pkg.files).toContain("skills");
  });
});

describe("the analyst brief's example", () => {
  it("parses as findings under the citation contract", () => {
    const findings = briefExample();

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(findingSchema.safeParse(finding).success).toBe(true);
  });

  it("fails the citation contract without its falsifier", () => {
    const [first] = briefExample();
    const entries = Object.entries(z.record(z.string(), z.unknown()).parse(first));
    const withoutFalsifier = Object.fromEntries(entries.filter(([key]) => key !== "falsifier"));

    expect(findingSchema.safeParse(withoutFalsifier).success).toBe(false);
  });
});

describe("the analyst brief's tools", () => {
  it("name no agent-chat command or tool", () => {
    expect(brief).not.toMatch(/agent-chat\s+[a-z]/);
    expect(brief).not.toMatch(/\b(?:agent|chat)_[a-z]+/);
  });
});
