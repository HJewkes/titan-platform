import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { g10HoldAt } from "./registration-hold.js";

const SHEPHERD_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SHEPHERD_DIR, "../../../..");
const ROOTS = ["registration-hold.ts", "g10-release.ts", "signoffs.ts"].map((name) => `${SHEPHERD_DIR}${name}`);

/**
 * Modules the hold's code reaches at run time that are deliberately not held: each is a general-purpose module whose
 * edit is not specific to the hold decision. Keep this list in step with the guide's "Accepted residual" paragraph.
 */
const ACCEPTED_RESIDUAL = new Set<string>([
  "products/factory/src/shepherd/store.ts",
  "products/factory/src/shepherd/events.ts",
]);

/** Value imports only: a type-only import is erased at build time and cannot change what the hold decides. */
const RELATIVE_VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.{1,2}\/[^"']+)\.js["']/gm;

/** Exact reasons, so an unread file list (which also holds g10-adversary) cannot satisfy the test by accident. */
const HELD_REASONS = new Set(["g10-adversary: policy touch", "g10-adversary: authority touch"]);

const isTest = (path: string): boolean => /\.test\.ts$/.test(path);

function relativeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found = [...source.matchAll(RELATIVE_VALUE_IMPORT)].map((m) => resolve(dirname(file), `${m[1]}.ts`));
  return found.filter((path) => path.startsWith(SHEPHERD_DIR) && existsSync(path) && !isTest(path));
}

/**
 * Every Shepherd source file the roots import, transitively, following relative value imports. The walk stops at the
 * Shepherd directory: the panel and fix-proof packages are held whole by glob, and the shared workflow and config
 * modules outside it are the guide's accepted residual.
 */
function importClosure(roots: string[]): string[] {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const next of relativeImports(file)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].map((path) => relative(REPO_ROOT, path)).sort();
}

async function holdFor(path: string): Promise<string | undefined> {
  const fake = fakeGitHub({ repo: "octo/demo" });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, [{ path, status: "modified", additions: 1, deletions: 1 }]);
  return g10HoldAt(githubPort(fake.wire), { repo: "octo/demo", pr });
}

describe("the G10 hold table", () => {
  it("finds the modules the hold decision runs through", () => {
    expect(importClosure(ROOTS)).toEqual(
      expect.arrayContaining(["products/factory/src/shepherd/registration-hold.ts", "products/factory/src/shepherd/git-pr-files.ts", "products/factory/src/shepherd/tree-carry.ts", "products/factory/src/shepherd/reviewer-lineage.ts"]),
    );
  });

  it("holds every file in the import closure of the hold, the sign-off rule and the release, bar the accepted residual", async () => {
    const unheld: string[] = [];
    for (const path of importClosure(ROOTS).filter((p) => !ACCEPTED_RESIDUAL.has(p))) {
      if (!HELD_REASONS.has((await holdFor(path)) ?? "")) unheld.push(path);
    }

    expect(unheld).toEqual([]);
  });

  it.each(["index.ts", "glob.ts", "classify.ts", "aggregate.ts", "accept-verdict.ts", "plan.ts", "verdict-schemas.ts"])("holds the panel module %s the hold and the sign-off run through", async (name) => {
    expect(await holdFor(`packages/review-panel/src/${name}`)).toBe("g10-adversary: policy touch");
  });

  it("keeps the accepted residual to files that exist", () => {
    for (const path of ACCEPTED_RESIDUAL) expect(existsSync(`${REPO_ROOT}/${path}`)).toBe(true);
  });
});
