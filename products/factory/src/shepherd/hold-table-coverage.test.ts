import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { g10HoldAt } from "./registration-hold.js";

const SHEPHERD_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SHEPHERD_DIR, "../../../..");
const ROOTS = ["registration-hold.ts", "g10-release.ts", "signoffs.ts"].map((name) => `${SHEPHERD_DIR}${name}`);

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
 * modules outside it are not walked.
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

/** Every non-test Shepherd source file with a relative value import of one of the roots. */
function importersOf(roots: string[]): string[] {
  const targets = new Set(roots);
  return readdirSync(SHEPHERD_DIR)
    .filter((name) => name.endsWith(".ts") && !isTest(name))
    .map((name) => `${SHEPHERD_DIR}${name}`)
    .filter((file) => relativeImports(file).some((imported) => targets.has(imported)))
    .map((path) => relative(REPO_ROOT, path))
    .sort();
}

async function unheldOf(paths: string[]): Promise<string[]> {
  const unheld: string[] = [];
  for (const path of paths) {
    if (!HELD_REASONS.has((await holdFor(path)) ?? "")) unheld.push(path);
  }
  return unheld;
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

  it("holds every file the hold, the sign-off rule and the release import, transitively", async () => {
    expect(await unheldOf(importClosure(ROOTS))).toEqual([]);
  });

  it.each(["store.ts", "events.ts", "take-verdict.ts"])("holds %s, which writes or feeds the hold without a value import from a root", async (name) => {
    expect(await unheldOf([`products/factory/src/shepherd/${name}`])).toEqual([]);
  });

  it("holds every Shepherd module that imports the hold, the sign-off rule or the release", async () => {
    const importers = importersOf(ROOTS);

    expect(importers).toEqual(expect.arrayContaining(["products/factory/src/shepherd/review.ts", "products/factory/src/shepherd/spawn-facts.ts"]));
    expect(await unheldOf(importers)).toEqual([]);
  });

  it.each(["index.ts", "glob.ts", "classify.ts", "aggregate.ts", "accept-verdict.ts", "plan.ts", "verdict-schemas.ts"])("holds the panel module %s the hold and the sign-off run through", async (name) => {
    expect(await holdFor(`packages/review-panel/src/${name}`)).toBe("g10-adversary: policy touch");
  });
});
