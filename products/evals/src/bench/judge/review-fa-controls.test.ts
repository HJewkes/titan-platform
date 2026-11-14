import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewCase } from "../review/cases.js";
import { generateFaControls, type BuildBundle } from "./review-fa-controls.js";
import { parseFaControls, NOT_REAL, REAL } from "./review-fa.js";

const base = { kind: "correctness", repo: "o/r", pr: 1, head: "h", base: "b", split: "dev", hash: "x", stratum: { kind: "correctness", caseType: "clean" as const } };
const planted = (n: number): ReviewCase => ({ ...base, id: `p${n}`, caseType: "planted", gold: [{ path: "src/a.test.ts", line: 2 }], plant: { kind: "deleted-assertion", path: "src/a.test.ts", line: 2, text: "" } });
const clean = (n: number): ReviewCase => ({ ...base, id: `c${n}`, caseType: "clean", gold: [] });

const HEAD = ["// helper for totals", "export const total = 1;", "export const more = 2;"];
const DIFF = ["--- a/src/a.test.ts", "+++ b/src/a.test.ts", "@@ -1,2 +1,3 @@", " // helper for totals", " export const total = 1;", "+export const more = 2;"].join("\n");
const build: BuildBundle = (_case, dir) => {
  mkdirSync(join(dir, "head/src"), { recursive: true });
  writeFileSync(join(dir, "head/src/a.test.ts"), HEAD.join("\n"));
  writeFileSync(join(dir, "diff.patch"), DIFF);
  return Promise.resolve();
};

describe("generateFaControls", () => {
  const queue = [...[1, 2, 3, 4].map(planted), ...[1, 2, 3, 4].map(clean)];
  const scratch = join(mkdtempSync(join(tmpdir(), "fa-ctl-")), "s");

  it("returns half real and half not-real controls that parseFaControls accepts", async () => {
    const controls = await generateFaControls(queue, 4, "seed-a", build, scratch);
    expect(controls.map((entry) => entry.expected).sort()).toEqual([NOT_REAL, NOT_REAL, REAL, REAL]);
    expect(parseFaControls(controls)).toHaveLength(4);
    const fabricated = controls.find((entry) => entry.expected === NOT_REAL);
    expect([fabricated?.path, fabricated?.lineStart]).toEqual(["src/a.test.ts", 1]);
    expect(fabricated?.review).toContain("never assigned");
    expect(controls.find((entry) => entry.expected === REAL)?.review).toContain("assertion was deleted");
  });

  it("is deterministic for a seed and reshuffles for another", async () => {
    const keys = async (seed: string) => (await generateFaControls(queue, 4, seed, build, scratch)).map((entry) => entry.key);
    expect(await keys("seed-a")).toEqual(await keys("seed-a"));
    expect(await keys("seed-b")).not.toEqual(await keys("seed-a"));
  });

  it("deletes each bundle it built", async () => {
    await generateFaControls(queue, 2, "seed-a", build, scratch);
    expect(readdirSync(scratch)).toEqual([]);
    rmSync(dirname(scratch), { recursive: true, force: true });
  });

  it("fails when the queue cannot supply the controls", async () => {
    await expect(generateFaControls([planted(1)], 4, "seed-a", build, scratch)).rejects.toThrow(/only 1 of 4/);
  });
});
