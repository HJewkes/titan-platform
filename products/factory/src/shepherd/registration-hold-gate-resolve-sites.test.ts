import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGlobs } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { GATE_RESOLVE_CHECK_FILES } from "./g10-class-rules.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { g10HoldAt } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";

const file = (path: string, additions: number): PrFile => ({ path, status: "modified", additions, deletions: 0 });

function holdFor(files: PrFile[]): Promise<string | undefined> {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  return g10HoldAt(githubPort(fake.wire), { repo: REPO, pr });
}

describe("the G10 hold Shepherd places at registration on the gate-resolve closure check", () => {
  it("holds a change to only gate-resolve-sites.test.ts g10-adversary", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/gate-resolve-sites.test.ts", 3)])).toBe("g10-adversary: policy touch");
  });

  it("holds a change to only its mutation sidecar g10-adversary", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/gate-resolve-sites.test.mutations.json", 2)])).toBe("g10-adversary: policy touch");
  });

  it("holds a change to only a closure helper g10-adversary", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/gate-resolve-closure.test-helpers.ts", 1)])).toBe("g10-adversary: policy touch");
  });

  it("holds a change to only the repo-closure helper g10-adversary", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/gate-resolve-repo.test-helpers.ts", 1)])).toBe("g10-adversary: policy touch");
  });

  it("holds a rename of gate-resolve-sites.test.ts out of the check g10-adversary by its old path", async () => {
    const renamed: PrFile = { path: "products/factory/src/shepherd/other.test.ts", previousPath: "products/factory/src/shepherd/gate-resolve-sites.test.ts", status: "renamed", additions: 0, deletions: 0 };

    expect(await holdFor([renamed])).toBe("g10-adversary: policy touch");
  });

  it("holds a change to only a closure helper named in another case g10-adversary", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/Gate-Resolve-closure.test-helpers.ts", 1)])).toBe("g10-adversary: policy touch");
  });

  it("holds a rename that changes only the case of a closure helper g10-adversary", async () => {
    const renamed: PrFile = {
      path: "products/factory/src/shepherd/GATE-RESOLVE-closure.test-helpers.ts",
      previousPath: "products/factory/src/shepherd/Gate-Resolve-closure.test-helpers.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
    };

    expect(await holdFor([renamed])).toBe("g10-adversary: policy touch");
  });

  it("leaves a change to only another policy-named test file unheld", async () => {
    expect(await holdFor([file("products/factory/src/shepherd/gate-resolve-proof.test.ts", 3)])).toBeUndefined();
  });
});

const SHEPHERD_DIR = "products/factory/src/shepherd";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The test helpers a file imports by relative path, as repo paths. */
function helperImportsOf(repoPath: string): string[] {
  const source = readFileSync(join(REPO_ROOT, repoPath), "utf8");
  return [...source.matchAll(/from "\.\/([^"]+)\.test-helpers\.js"/g)].map((match) => `${SHEPHERD_DIR}/${match[1]}.test-helpers.ts`);
}

/** Every test helper the closure check reaches through relative imports, the check itself included. */
function closureCheckModules(): string[] {
  const seen = new Set<string>();
  const queue = [`${SHEPHERD_DIR}/gate-resolve-sites.test.ts`];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...helperImportsOf(next));
  }
  return [...seen];
}

describe("the gate-resolve check unit in Shepherd's class rules", () => {
  it("names the check, its sidecar and every test helper the check imports", () => {
    const inUnit = compileGlobs(GATE_RESOLVE_CHECK_FILES);
    const modules = [...closureCheckModules(), `${SHEPHERD_DIR}/gate-resolve-sites.test.mutations.json`];
    expect(modules.length).toBeGreaterThan(2);
    expect(modules.filter((path) => !inUnit(path))).toEqual([]);
  });
});
