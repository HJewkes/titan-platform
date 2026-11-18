import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STAGE_BODY_CHECKS, STAGE_CHECKS } from "./stage-checks.js";

const UNITS = fileURLToPath(new URL("../../../evals/units/", import.meta.url));
const SuiteSchema = z.object({ checks: z.array(z.object({ params: z.object({ verdict: z.string().optional() }).optional() })) });
const VERDICT = /^(?:rows\[stage=(\w+)\]\.checkRows|checks)\[name=([^\]]+)\]$/;

interface Verdict {
  unit: string;
  stage: string;
  name: string;
}

function verdictsOf(unit: string): Verdict[] {
  const suite = SuiteSchema.parse(JSON.parse(readFileSync(join(UNITS, unit, "suite.json"), "utf8")));
  const stageOfUnit = unit.replace(/^explainer-/, "");
  return suite.checks.flatMap((check) => {
    const match = VERDICT.exec(check.params?.verdict ?? "");
    return match ? [{ unit, stage: match[1] ?? stageOfUnit, name: match[2]! }] : [];
  });
}

const emitted = (stage: string): string[] => [
  ...((STAGE_CHECKS as Record<string, readonly { name: string }[]>)[stage] ?? []).map((check) => check.name),
  ...((STAGE_BODY_CHECKS as Record<string, readonly string[]>)[stage] ?? []),
];

describe("explainer eval suites", () => {
  const verdicts = readdirSync(UNITS).filter((dir) => dir.startsWith("explainer-")).flatMap(verdictsOf);

  it("reads at least one check verdict", () => {
    expect(verdicts.length).toBeGreaterThan(0);
  });

  it("names only checks that the verdict's stage emits", () => {
    const stale = verdicts.filter((v) => !emitted(v.stage).includes(v.name)).map((v) => `${v.unit}: ${v.stage} emits no check named ${v.name}`);

    expect(stale).toEqual([]);
  });
});
