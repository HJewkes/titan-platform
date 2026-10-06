import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineGrowth,
  compareBaseline,
  deadExportMessage,
  entryFiles,
  exitCode,
  findDeadExports,
  formatReport,
  graphFromDb,
  parseCliArgs,
  readBaseBaseline,
  ROOT_ROLES,
  updatedBaseline,
} from "./dead-code-check.mjs";
import { maskSource } from "./dead-code-check-source.mjs";
import { release, tryAcquire } from "./dag-check-lock.mjs";

const file = (id, role = "source") => ({ id, kind: "file", name: id.split("/").pop(), role });
const symbol = (fileId, name, exported = true) => ({
  id: `${fileId}#${name}`,
  kind: "symbol",
  name,
  parentId: fileId,
  attrs: { exported },
});
const edge = (srcId, dstId, kind) => ({ srcId, dstId, kind });
const ids = (findings) => findings.map((f) => f.id);

const PKG = "packages/demo";
const INDEX = `${PKG}/src/index.ts`;
const API = `${PKG}/src/api.ts`;
const INTERNAL = `${PKG}/src/internal.ts`;
const HELPER = `${PKG}/src/helper.ts`;

function demoGraph() {
  const nodes = [file(INDEX, "barrel"), file(API), file(INTERNAL), file(HELPER)];
  nodes.push(symbol(API, "publicFn"), symbol(INTERNAL, "orphan"), symbol(INTERNAL, "used"), symbol(HELPER, "local", false));
  const edges = [edge(INDEX, API, "re-exports"), edge(API, `${INTERNAL}#used`, "references")];
  return { nodes, edges };
}

function findingsIn({ nodes, edges }, { packages = [{ dir: PKG, manifest: {} }], sources = {} } = {}) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  return findDeadExports({ nodes, edges, entries: entryFiles(packages, files), readSource: (id) => sources[id] ?? "" });
}

const deadIn = (graph, options) => ids(findingsIn(graph, options));

const tmpDirs = [];
function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "dead-check-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => tmpDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("finding exports with no importer", () => {
  it("lists a non-entry module export that no other file imports", () => {
    expect(deadIn(demoGraph())).toEqual([`${INTERNAL}#orphan`]);
  });

  it("never lists an export the package entry re-exports, since consumer repos may import it", () => {
    expect(deadIn(demoGraph())).not.toContain(`${API}#publicFn`);
  });

  it("follows re-exports through an intermediate barrel to the declaring module", () => {
    const { nodes, edges } = demoGraph();
    const mid = `${PKG}/src/mid/index.ts`;
    nodes.push(file(mid, "barrel"));
    edges.push(edge(INDEX, mid, "re-exports"), edge(mid, INTERNAL, "re-exports"));
    expect(deadIn({ nodes, edges })).toEqual([]);
  });

  it("treats a package.json subpath export as an entry, mapping dist back to src", () => {
    const { nodes, edges } = demoGraph();
    const vite = `${PKG}/src/vite/index.ts`;
    nodes.push(file(vite, "barrel"), symbol(vite, "plugin"));
    const manifest = { exports: { ".": { import: "./dist/index.js" }, "./vite": { types: "./dist/vite.d.ts", import: "./dist/vite.js" } } };
    expect(deadIn({ nodes, edges }, { packages: [{ dir: PKG, manifest }] })).not.toContain(`${vite}#plugin`);
  });

  it("does not count a use inside the declaring file as an importer", () => {
    const { nodes, edges } = demoGraph();
    edges.push(edge(INTERNAL, `${INTERNAL}#orphan`, "calls"));
    expect(deadIn({ nodes, edges })).toContain(`${INTERNAL}#orphan`);
  });

  it("counts a test file's import as an importer and skips exports declared in tests", () => {
    const { nodes, edges } = demoGraph();
    const test = `${PKG}/src/internal.test.ts`;
    nodes.push(file(test, "test"), symbol(test, "fixtureFactory"));
    edges.push(edge(test, `${INTERNAL}#orphan`, "references"));
    expect(deadIn({ nodes, edges })).toEqual([]);
  });
});

describe("modules imported whole", () => {
  const CONSUMER = `${PKG}/src/consumer.ts`;
  function importedBy(source) {
    const { nodes, edges } = demoGraph();
    nodes.push(file(CONSUMER));
    edges.push({ ...edge(CONSUMER, INTERNAL, "imports"), attrs: { specifier: "./internal.js" } });
    return deadIn({ nodes, edges }, { sources: { [CONSUMER]: source } });
  }

  it("treats a namespace import as using every export of the module", () => {
    expect(importedBy('import * as internal from "./internal.js";\ninternal.orphan();')).toEqual([]);
  });

  it("treats a bare dynamic import as using every export of the module", () => {
    expect(importedBy('const internal = await import("./internal.js");')).toEqual([]);
  });

  it("ignores a namespace import written inside a comment or a string", () => {
    expect(importedBy('// import * as internal from "./internal.js";\nconst s = \'import * as internal from "./internal.js"\';')).toEqual([
      `${INTERNAL}#orphan`,
    ]);
  });

  it("still lists exports when the import named a binding code-graph could not resolve to a symbol", () => {
    expect(importedBy('import { reexportedFromNpm } from "./internal.js";')).toEqual([`${INTERNAL}#orphan`]);
  });

  it("follows a namespace-imported barrel to the modules it re-exports", () => {
    const { nodes, edges } = demoGraph();
    const barrel = `${PKG}/src/internal-barrel.ts`;
    nodes.push(file(CONSUMER), file(barrel, "barrel"));
    edges.push(edge(barrel, INTERNAL, "re-exports"), { ...edge(CONSUMER, barrel, "imports"), attrs: { specifier: "./internal-barrel.js" } });
    expect(deadIn({ nodes, edges }, { sources: { [CONSUMER]: 'import * as all from "./internal-barrel.js";' } })).toEqual([]);
  });
});

describe("exports used only inside their own file", () => {
  const localOnlyIn = (source) => findingsIn(demoGraph(), { sources: { [INTERNAL]: source } })[0].localOnly;

  it("marks an export its own file uses in a type position as local-only", () => {
    expect(localOnlyIn("export interface orphan { a: number }\nexport function used(o: orphan): void {}\n")).toBe(true);
  });

  it("marks an export its own file uses at module top level as local-only", () => {
    expect(localOnlyIn("export const orphan = 5;\nconst rows = load(orphan);\n")).toBe(true);
  });

  it("marks an export used inside a template expression as local-only", () => {
    expect(localOnlyIn("export const orphan = 5;\nconst label = `limit ${orphan}`;\n")).toBe(true);
  });

  it("does not count comments, strings, property names or an export list as uses", () => {
    const source = 'export const orphan = 1; // orphan\n/* orphan */ const s = "orphan" + `orphan`;\nconst p = obj.orphan;\nexport { orphan as alias };\n';
    expect(localOnlyIn(source)).toBe(false);
  });

  it("tells the author to drop the export keyword rather than delete the code", () => {
    expect(deadExportMessage({ name: "helper", file: "src/a.ts", localOnly: true })).toBe(
      "`helper` in `src/a.ts` is used only inside its own file. Drop the export keyword. If an external consumer needs it, export it from the package entry.",
    );
  });
});

describe("masking comments and literals in source", () => {
  it("blanks comment, string and template text to spaces and keeps every offset", () => {
    const source = 'a("x") // c\nb(`t ${y} u`) /* d */';
    const masked = maskSource(source);
    expect(masked).toHaveLength(source.length);
    expect(masked).toBe('a(" ")     \nb(`  ${y}  `)        ');
  });

  it("does not let a quote inside a regex literal swallow the code after it", () => {
    expect(maskSource("const r = /'/;\nuse(orphan);\n")).toContain("use(orphan);");
  });
});

describe("the shrink-only baseline", () => {
  const finding = (id) => ({ id, name: id.split("#")[1], file: id.split("#")[0] });

  it("fails only on a dead export the baseline does not hold", () => {
    const result = compareBaseline([finding("a.ts#old"), finding("b.ts#new")], ["a.ts#old"]);
    expect(ids(result.fresh)).toEqual(["b.ts#new"]);
    expect(ids(result.carried)).toEqual(["a.ts#old"]);
  });

  it("reports a baselined export removed from the code as fixed, never as a failure", () => {
    const result = compareBaseline([], ["a.ts#gone"]);
    expect(result.fresh).toEqual([]);
    expect(result.fixed).toEqual(["a.ts#gone"]);
  });

  it("drops fixed entries on update and never adds a new finding", () => {
    expect(updatedBaseline([finding("a.ts#old"), finding("b.ts#new")], ["a.ts#old", "c.ts#gone"])).toEqual(["a.ts#old"]);
  });

  it("seeds a missing baseline with every current finding", () => {
    expect(updatedBaseline([finding("a.ts#x")], null)).toEqual(["a.ts#x"]);
  });

  it("reports every entry the base branch's baseline does not hold as growth", () => {
    expect(baselineGrowth(["a.ts#old", "b.ts#added"], ["a.ts#old", "c.ts#fixed"])).toEqual(["b.ts#added"]);
  });

  it("fails on baseline growth even in a report-only run", () => {
    expect(exitCode({ growth: ["b.ts#added"], fresh: [], reportOnly: true })).toBe(1);
    expect(exitCode({ growth: [], fresh: [finding("b.ts#new")], reportOnly: true })).toBe(0);
    expect(exitCode({ growth: [], fresh: [finding("b.ts#new")], reportOnly: false })).toBe(1);
  });
});

describe("reading the base branch's baseline", () => {
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      stdio: "ignore",
    });

  function repoWith(baseline) {
    const dir = scratchDir();
    git(dir, "init", "-q", "-b", "main");
    if (baseline) {
      mkdirSync(path.join(dir, ".codewatch"));
      writeFileSync(path.join(dir, ".codewatch/dead-exports.json"), JSON.stringify(baseline));
      git(dir, "add", ".");
    }
    git(dir, "commit", "-q", "--allow-empty", "-m", "base");
    return dir;
  }

  it("reads the baseline committed at the ref", () => {
    expect(readBaseBaseline("main", repoWith(["a.ts#x"]))).toEqual(["a.ts#x"]);
  });

  it("treats a ref without a baseline file as an empty baseline", () => {
    expect(readBaseBaseline("main", repoWith(null))).toEqual([]);
  });

  it("throws on a ref that does not exist instead of passing silently", () => {
    expect(() => readBaseBaseline("no-such-branch", repoWith(["a.ts#x"]))).toThrow();
  });
});

describe("the script header", () => {
  const header = readFileSync(new URL("./dead-code-check.mjs", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/\s*/, ""))
    .join(" ");

  it("documents the exit codes the script really returns", () => {
    expect(header).not.toContain("always exits 0");
    expect(header).toContain("Exits 1 on a new dead export, or 0 under --report-only");
    expect(header).toContain("Exits 2 on an index failure, a lock timeout, a BASE_REF that names no commit, an unknown flag,");
    expect(header).toContain('a --db path that does not exist or holds no "head" snapshot, or an out-of-memory abort');
  });
});

describe("root roles", () => {
  it("match the roles code-graph treats as unimported by design", async () => {
    const { UNIMPORTED_ROLES } = await import(new URL("../packages/code-graph/dist/index.js", import.meta.url).href);

    expect([...ROOT_ROLES].sort()).toEqual([...UNIMPORTED_ROLES].sort());
  });
});

describe("reading an existing code-graph database", () => {
  const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);
  const SCRIPT = new URL("./dead-code-check.mjs", import.meta.url).pathname;

  function writeNodes(store, snapshotId, name) {
    store.insertNodes(snapshotId, [file("src/lib.ts"), symbol("src/lib.ts", name)]);
  }

  function writeHead(store, name) {
    writeNodes(store, store.createSnapshot({ ref: "head", indexVersion: "" }), name);
  }

  /** The real CLI, with HOME moved so its dag-check lock is this test's own. */
  function spawnDeadCheck(dbPath, home) {
    const env = { ...process.env, HOME: home };
    delete env.BASE_REF;
    const child = spawn(process.execPath, [SCRIPT, "--report-only", "--db", dbPath], { env });
    child.out = "";
    child.stdout.on("data", (chunk) => (child.out += chunk));
    return child;
  }

  function waitForOutput(stream, text) {
    let seen = "";
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => (seen += chunk).includes(text) && resolve());
      stream.on("end", () => reject(new Error(`stream ended without "${text}": ${seen}`)));
    });
  }

  async function indexFixture(sources) {
    const dir = scratchDir();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [rel, text] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    const graph = await import(ENTRY.href);
    const dbPath = path.join(dir, "graph.db");
    const store = graph.openCodeGraph(dbPath);
    await graph.indexPaths(store, { paths: [path.join(dir, "src")], ref: "head", computeChurn: false });
    store.close();
    return dbPath;
  }

  it("parses --db alongside the other flags", () => {
    expect(parseCliArgs(["--report-only", "--db", "/tmp/graph.db"])).toEqual({ db: "/tmp/graph.db", reportOnly: true, update: false });
    expect(parseCliArgs([]).db).toBeNull();
  });

  it("reads the head snapshot, where a real namespace import leaves only a file-level edge", async () => {
    const dbPath = await indexFixture({
      "src/lib.ts": "export const viaNamespace = 1;\n",
      "src/main.ts": 'import * as lib from "./lib.js";\nexport const total = lib.viaNamespace;\n',
    });
    const { nodes, edges } = await graphFromDb(dbPath);
    const lib = nodes.find((n) => n.kind === "file" && n.id.endsWith("src/lib.ts")).id;
    expect(edges.filter((e) => e.dstId.startsWith(lib)).map((e) => e.kind)).toEqual(["imports"]);
  });

  it("waits for a writer holding the dag-check lock instead of reading its half-written head snapshot", async () => {
    const graph = await import(ENTRY.href);
    const home = scratchDir();
    const dbPath = path.join(home, "graph.db");
    const store = graph.openCodeGraph(dbPath);
    writeHead(store, "first");
    const lockDir = path.join(home, ".cache", "titan-platform", "dag-check.lock");
    expect(tryAcquire(lockDir)).toBeNull();
    const pending = store.createSnapshot({ ref: "head", indexVersion: "" });
    const reader = spawnDeadCheck(dbPath, home);
    await waitForOutput(reader.stderr, "waiting for dag-check lock");
    writeNodes(store, pending, "second");
    store.close();
    release(lockDir);
    const [code] = await once(reader, "exit");
    expect(code).toBe(0);
    expect(reader.out).toContain("`second` in `src/lib.ts` has no importer");
  }, 30000);

  it("refuses a database path that does not exist rather than creating an empty one", async () => {
    const dbPath = path.join(scratchDir(), "missing.db");
    await expect(graphFromDb(dbPath)).rejects.toThrow("not found");
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("the report", () => {
  it("prints the R12 remediation for a new dead export", () => {
    expect(deadExportMessage({ name: "orphan", file: "src/internal.ts" })).toBe(
      "`orphan` in `src/internal.ts` has no importer. Delete it and its tests. If an external consumer needs it, export it from the package entry.",
    );
  });

  it("says a report-only run failed when the baseline grew", () => {
    const fresh = [{ id: "a.ts#x", name: "x", file: "a.ts" }];
    const report = formatReport({ fresh, carried: [], fixed: [] }, { reportOnly: true, grew: true });
    expect(report).toContain("the baseline grew — failed.");
    expect(report).not.toContain("not failing");
  });

  it("says a report-only run does not fail", () => {
    const fresh = [{ id: "a.ts#x", name: "x", file: "a.ts" }];
    expect(formatReport({ fresh, carried: [], fixed: [] }, { reportOnly: true })).toContain("report-only, not failing");
  });
});
