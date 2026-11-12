import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evidenceOf, HEAD, BASE, png } from "./pr-visual-evidence.test-helpers.js";
import { visualTier } from "./visual-tier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECISION_ROOTS = ["visual-tier.ts", "visual-tier-guard.ts", "merge-facts.ts"].map((file) => resolve(HERE, file));
const EVIDENCE = new Set(["pr-visual-evidence.ts", "pr-visual-zip.ts", "pr-visual-round.ts"].map((file) => resolve(HERE, file)));
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)\.js["']/g;

/** Every local source file the roots reach through static, re-export or dynamic imports. */
function importClosure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)) queue.push(resolve(dirname(file), `${spec}.ts`));
  }
  return seen;
}

const paths = { storyPaths: ["**/*.stories.tsx"], logicPaths: ["src/**"], testArtifactPaths: ["**/*.json"], renderingPaths: ["src/tokens/**"], harnessPaths: ["scripts/**"] };
const tierConfig = { mode: "on", ...paths, storyDiff: { check: "visual", paths: ["**/__snapshots__/**"], allowedApps: [1] } };

describe("pr-visual evidence never reaches the visual tier (TP-4761 C1)", () => {
  it("the merge guard cannot import pr-visual evidence", () => {
    const closure = importClosure(DECISION_ROOTS);

    expect(closure.size).toBeGreaterThan(DECISION_ROOTS.length);
    expect([...closure].filter((file) => EVIDENCE.has(file))).toEqual([]);
  });

  it("a zero-diff artifact on a rendered path still gives tier 2", async () => {
    const evidence = await evidenceOf({ pairs: [[png(), png()]] });
    const merge = { head: HEAD, changedPaths: ["src/button/button.tsx"], checkRuns: [] };

    const verdict = visualTier({ merge, visualPaths: ["src/**"], mergeBase: BASE, config: tierConfig, ...{ evidence } });

    expect(evidence).toMatchObject({ measured: true, missing: [] });
    expect(verdict).toEqual({ tier: 2, reason: "renders: src/button/button.tsx" });
  });
});
