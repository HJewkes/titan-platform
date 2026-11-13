import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUMPS_DIR, readBumpRows, withRecordedBumps, type BumpRow } from "./bumps.js";
import { closureVerdict, type ClosureLock } from "./closure.js";
import { isFactEntry } from "./entry.js";
import { seedFactSteps } from "./steps/seed-facts.js";

const PR_A = 101;
const PR_B = 102;
const declared = seedFactSteps.find((entry) => entry.name === "ci-wait")!.version.bump;

function bumpOf(step: string, rows: readonly BumpRow[]): number {
  const entry = withRecordedBumps(seedFactSteps, rows).find((candidate) => candidate.name === step);
  if (!entry || !isFactEntry(entry)) throw new Error(`no fact entry ${step}`);
  return entry.version.bump;
}

/** The lock a tree implies for ci-wait: its closure as given, its bump from the tree's rows. */
const lockOf = (closure: string, rows: readonly BumpRow[]): ClosureLock => ({ "ci-wait": { closure, schemaHash: "schema-1", bump: bumpOf("ci-wait", rows) } });

describe("per-PR version bumps", () => {
  const main = lockOf("closure-main", []);
  const rowA = { step: "ci-wait", pr: PR_A };
  const rowB = { step: "ci-wait", pr: PR_B };

  it("two PRs bumping one step both pass after either lands, with no re-bump", () => {
    for (const [first, second] of [[rowA, rowB], [rowB, rowA]] as const) {
      const firstLanded = lockOf("closure-first", [first]);
      const secondMerged = lockOf("closure-both", [first, second]);

      expect(closureVerdict(main, firstLanded, [])).toEqual([]);
      expect(closureVerdict(firstLanded, secondMerged, [])).toEqual([]);
      expect(secondMerged["ci-wait"]!.bump).toBe(declared + 2);
    }
  });

  it("a landed row does not cover a later PR's closure change", () => {
    const bothLanded = lockOf("closure-both", [rowA, rowB]);

    const later = lockOf("closure-later", [rowA, rowB]);

    expect(closureVerdict(bothLanded, later, [])).toEqual([expect.stringContaining("ci-wait")]);
  });

  it("one PR's rows count once however often they name the step", () => {
    expect(bumpOf("ci-wait", [rowA, rowA])).toBe(declared + 1);
  });

  it("a row moves only the step it names", () => {
    const merge = seedFactSteps.find((entry) => entry.name === "merge")!.version.bump;

    expect(bumpOf("merge", [rowA])).toBe(merge);
  });
});

describe("reading bump rows", () => {
  const root = mkdtempSync(join(tmpdir(), "bumps-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a checkout with no bumps directory has no rows", () => {
    expect(readBumpRows(root)).toEqual([]);
  });

  it("reads every <pr>.json and skips other names", () => {
    mkdirSync(join(root, BUMPS_DIR), { recursive: true });
    writeFileSync(join(root, BUMPS_DIR, `${PR_A}.json`), JSON.stringify([{ step: "ci-wait", pr: PR_A }]));
    writeFileSync(join(root, BUMPS_DIR, "README.md"), "not rows");

    expect(readBumpRows(root)).toEqual([{ step: "ci-wait", pr: PR_A }]);
  });

  it("a malformed row throws rather than counting as no bump", () => {
    writeFileSync(join(root, BUMPS_DIR, `${PR_B}.json`), JSON.stringify([{ step: "ci-wait" }]));

    expect(() => readBumpRows(root)).toThrow();
  });
});
