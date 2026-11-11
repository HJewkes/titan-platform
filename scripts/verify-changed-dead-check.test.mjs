import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareBaseline, entryFiles, findDeadExports, parseCliArgs, scopeToPaths } from "./dead-code-check.mjs";
import { describeOutcome, planCommands } from "./verify-changed.mjs";

const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);

const WORKSPACE = [
  { dir: "packages/a/", name: "a", deps: [] },
  { dir: "packages/b/", name: "b", deps: ["a"] },
  { dir: "products/c/", name: "c", deps: [] },
  { dir: "deploy/hub/", name: "hub", deps: [] },
];

const deadCheckStep = (changed, indexedFiles = () => 10, seedExists = () => false) =>
  planCommands({ base: "origin/base", changed, workspace: WORKSPACE, hasTimeout: true, indexedFiles, seedExists }).find((step) => step.label.startsWith("dead:check"));

describe("verify:changed dead:check step", () => {
  it("indexes only the touched graph-root packages and checks baseline growth against the base", () => {
    const step = deadCheckStep(["packages/a/src/x.ts", "products/c/README.md", "deploy/hub/src/y.ts", "site/z.md"]);

    expect(step.args).toEqual(["scripts/dead-code-check.mjs", "--paths=packages/a,products/c"]);
    expect(step.env.BASE_REF).toBe("origin/base");
  });

  it("dead:check carries a short lock wait in its env", () => {
    vi.stubEnv("DAG_CHECK_LOCK_WAIT_MS", "");
    delete process.env.DAG_CHECK_LOCK_WAIT_MS;

    expect(deadCheckStep(["packages/a/src/x.ts"]).env.DAG_CHECK_LOCK_WAIT_MS).toBe("30000");
  });

  it("lets the caller's own lock wait override the local budget", () => {
    vi.stubEnv("DAG_CHECK_LOCK_WAIT_MS", "5000");

    expect(deadCheckStep(["packages/a/src/x.ts"]).env.DAG_CHECK_LOCK_WAIT_MS).toBe("5000");
  });

  it("a busy-lock exit defers dead:check to CI instead of failing", () => {
    const step = deadCheckStep(["packages/a/src/x.ts"]);

    expect(describeOutcome(step, 75)).toEqual({ ok: true, note: "dead:check deferred to CI: dag-check lock busy" });
  });

  it("any other dead:check exit still fails", () => {
    const step = deadCheckStep(["packages/a/src/x.ts"]);

    expect(describeOutcome(step, 1).ok).toBe(false);
    expect(describeOutcome(step, 2).ok).toBe(false);
    expect(describeOutcome({ label: "lint", cmd: "pnpm" }, 75).ok).toBe(false);
  });

  it("defers to CI when the touched packages hold more files than the local budget", () => {
    const sized = (files) => deadCheckStep(["packages/a/src/x.ts"], () => files);

    expect(sized(600).args).toEqual(["scripts/dead-code-check.mjs", "--paths=packages/a"]);
    expect(sized(601)).toEqual({ label: "dead:check: 601 files in packages/a exceed the 600-file local budget, deferred to CI", deferred: true });
  });

  it("runs dead:check on a products/factory change when the machine seed exists", () => {
    const step = deadCheckStep(["packages/a/src/x.ts"], () => 1641, () => true);

    expect(step.args).toEqual(["scripts/dead-code-check.mjs", "--paths=packages/a"]);
    expect(step.deferred).toBeUndefined();
  });

  it("still defers a member past the file budget to CI when no machine seed exists", () => {
    const step = deadCheckStep(["packages/a/src/x.ts"], () => 1641, () => false);

    expect(step).toEqual({ label: "dead:check: 1641 files in packages/a exceed the 600-file local budget, deferred to CI", deferred: true });
  });

  it("is skipped when no graph-root package changed", () => {
    expect(deadCheckStep(["scripts/x.mjs", "deploy/hub/src/y.ts"])).toBeUndefined();
  });
});

describe("a --paths dead:check run", () => {
  it("judges only the scoped packages' baseline entries, so the rest are neither carried nor fixed", () => {
    const findings = [{ id: "packages/a/src/x.ts#kept" }, { id: "packages/b/src/y.ts#other" }];
    const baseline = ["packages/a/src/x.ts#kept", "packages/b/src/y.ts#old"];

    const scoped = scopeToPaths(findings, baseline, ["packages/a"]);
    const result = compareBaseline(scoped.findings, scoped.baseline);

    expect(result).toEqual({ fresh: [], carried: [{ id: "packages/a/src/x.ts#kept" }], fixed: [] });
  });

  it("refuses --update, which would drop the unscoped packages' baseline entries", () => {
    expect(() => parseCliArgs(["--paths=packages/a", "--update"])).toThrow("--paths cannot be combined with --update");
    expect(parseCliArgs(["--paths=packages/a,products/c"]).paths).toEqual(["packages/a", "products/c"]);
  });
});

const tmpDirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  tmpDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const PKG = "packages/demo";
const MANIFEST = { name: "demo", exports: { ".": "./dist/index.js" } };
const BASE_SOURCES = {
  "src/index.ts": 'export { run } from "./run.js";\n',
  "src/run.ts": 'import { helper } from "./helper.js";\nexport function run() {\n  return helper();\n}\n',
};

/** A synthetic repo holding one package on its branch's sources, indexed only at that package as --paths does. */
async function scopedFresh(branchSources) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-dead-check-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const sources = { "package.json": JSON.stringify(MANIFEST), ...BASE_SOURCES, ...branchSources };
  for (const [rel, text] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(dir, PKG, rel)), { recursive: true });
    writeFileSync(path.join(dir, PKG, rel), text);
  }
  const graph = await import(ENTRY.href);
  const store = graph.openCodeGraph(path.join(dir, "graph.db"));
  try {
    const r = await graph.indexPaths(store, { paths: [path.join(dir, PKG)], ref: "head", computeChurn: false });
    const nodes = graph.listNodes(store, r.snapshotId, { includeSymbols: true });
    const edges = graph.listEdges(store, r.snapshotId, { includeReferences: true });
    const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
    const entries = entryFiles([{ dir: PKG, manifest: MANIFEST }], files);
    const readSource = (id) => readFileSync(path.join(dir, id), "utf8");
    const scoped = scopeToPaths(findDeadExports({ nodes, edges, entries, readSource }), [], [PKG]);
    return compareBaseline(scoped.findings, scoped.baseline).fresh;
  } finally {
    store.close();
  }
}

describe("a branch checked by the scoped dead:check", () => {
  it("is refused when it adds an export used only in its own file", async () => {
    const fresh = await scopedFresh({
      "src/helper.ts": "export const LIMIT = 3;\nexport function helper() {\n  return LIMIT;\n}\n",
    });

    expect(fresh.map((f) => [f.id, f.localOnly])).toEqual([[`${PKG}/src/helper.ts#LIMIT`, true]]);
  }, 30000);

  it("passes when the new export is imported by another file", async () => {
    const fresh = await scopedFresh({
      "src/limits.ts": "export const LIMIT = 3;\n",
      "src/helper.ts": 'import { LIMIT } from "./limits.js";\nexport function helper() {\n  return LIMIT;\n}\n',
    });

    expect(fresh).toEqual([]);
  }, 30000);
});
