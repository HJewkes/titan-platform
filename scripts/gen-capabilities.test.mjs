import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { catalogText, firstSentence, keyExports, parseExports, parseUseWhen, run, tableRow } from "./gen-capabilities.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

describe("reading a package's exports from its index", () => {
  it("records each re-exported name with its module and whether it is a type", () => {
    const source = [
      'export type { RunConfig } from "./types.js";',
      'export { runAgent, type AgentInit, prepareEnv as scrubEnv } from "./run.js";',
    ].join("\n");
    expect(parseExports(source)).toEqual([
      { name: "RunConfig", type: true, from: "./types.js" },
      { name: "runAgent", type: false, from: "./run.js" },
      { name: "AgentInit", type: true, from: "./run.js" },
      { name: "scrubEnv", type: false, from: "./run.js" },
    ]);
  });

  it("follows export-star through the resolver and keeps the star's module as the concern", () => {
    const resolveStar = () => [{ name: "resolveNode", type: false, from: "./nodes.js" }];
    expect(parseExports('export * from "./query/index.js";', resolveStar)).toEqual([
      { name: "resolveNode", type: false, from: "./query/index.js" },
    ]);
  });

  it("counts declarations written in the index itself", () => {
    const source = "export interface Identity { id: string }\nexport function conversationRef() {}\n";
    expect(parseExports(source)).toEqual([
      { name: "Identity", type: true, from: "./index.js" },
      { name: "conversationRef", type: false, from: "./index.js" },
    ]);
  });
});

describe("choosing the key exports", () => {
  const entry = (name, from, type = false) => ({ name, from, type });

  it("puts callables before constants and types, then regroups the picks by module", () => {
    const entries = [entry("Config", "./types.js", true), entry("MAX_RETRIES", "./env.js"), entry("prepareEnv", "./env.js"), entry("runAgent", "./run.js")];
    expect(keyExports(entries, 3)).toEqual({
      groups: [
        { concern: "env", names: ["MAX_RETRIES", "prepareEnv"] },
        { concern: "run", names: ["runAgent"] },
      ],
      more: 1,
    });
  });

  it("names a directory index by its directory", () => {
    expect(keyExports([entry("resolveNode", "./query/index.js")]).groups).toEqual([{ concern: "query", names: ["resolveNode"] }]);
  });
});

describe("reading a CAPABILITY.md", () => {
  it("drops the heading and the authoring comment and keeps each prose line as its own line", () => {
    const markdown = "# agent: use this when\n\n<!-- guidance for authors -->\n\nYou run one agent.\n\n\nIt needs a token.\n\n";
    expect(parseUseWhen(markdown)).toEqual(["You run one agent.", "", "It needs a token."]);
  });

  it("ships in the package template so every stamped package starts with one", () => {
    const template = readFileSync(join(REPO, "templates", "package", "CAPABILITY.md"), "utf8");
    expect(parseUseWhen(template).join("\n")).toContain("__NAME__");
  });

  it("gives the quick index only the opening sentence", () => {
    expect(firstSentence(["You run one agent. It needs a token.", "", "Later prose."])).toBe("You run one agent.");
    expect(firstSentence(["Call `fake({ ... })` to build one. Then pass it."])).toBe("Call `fake({ ... })` to build one.");
    expect(firstSentence(["No full stop"])).toBe("No full stop");
  });
});

describe("merging two pull requests that change one unit", () => {
  const INDEX = "packages/hitl/src/index.ts";
  const CAP = "packages/hitl/CAPABILITY.md";
  const tempDirs = [];
  afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "gen-capabilities-merge-"));
    tempDirs.push(dir);
    return dir;
  }

  const gates = Array.from({ length: 13 }, (_, i) => `export function gate${i}() {}`);
  const record = "export interface GateRecord { id: string }";
  const prose = ["You open a gate for a person.", "", "It waits for an answer.", "", "It records who answered."];
  const BASE = { index: [...gates, record], useWhen: prose };
  const OURS = { index: [...gates, "export function openGate() {}", record], useWhen: ["You open a gate for a person and wait on it.", ...prose.slice(1)] };
  const THEIRS = { index: [...gates, record, "export function closeGate() {}", "export function listGates() {}"], useWhen: [...prose.slice(0, 4), "It records who answered and when."] };

  function sources({ index, useWhen }) {
    return { [INDEX]: `${index.join("\n")}\n`, [CAP]: ["# hitl: use this when", "", ...useWhen, ""].join("\n") };
  }

  function catalogOf(unitFiles) {
    const dir = scratch();
    const files = {
      ".codewatch/check.json": JSON.stringify({ rules: [{ type: "layered-deps", $tiers: { 1: ["packages/hitl"] } }] }),
      "scripts/capabilities-data.json": JSON.stringify({ runtimePaths: [], knownGaps: [], external: { "react-ui": "You build a screen." } }),
      "packages/hitl/package.json": JSON.stringify({ name: "@titan-design/hitl", version: "1.0.0", description: "Human approval gates" }),
      ...unitFiles,
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    for (const group of ["products", "apps"]) mkdirSync(join(dir, group));
    return catalogText(dir);
  }

  function mergeFile(base, ours, theirs) {
    const dir = scratch();
    const paths = Object.entries({ ours, base, theirs }).map(([name, text]) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    });
    const { status, stdout } = spawnSync("git", ["merge-file", "-p", ...paths], { encoding: "utf8" });
    return { status, text: stdout };
  }

  it("adding exports and editing different CAPABILITY.md lines merges cleanly into the catalog the merged sources generate", () => {
    const [base, ours, theirs] = [BASE, OURS, THEIRS].map(sources);
    const mergedSources = [INDEX, CAP].map((file) => [file, mergeFile(base[file], ours[file], theirs[file])]);
    expect(mergedSources.map(([, merged]) => merged.status)).toEqual([0, 0]);

    const merged = mergeFile(catalogOf(base), catalogOf(ours), catalogOf(theirs));

    expect(merged.status).toBe(0);
    expect(merged.text).toBe(catalogOf(Object.fromEntries(mergedSources.map(([file, m]) => [file, m.text]))));
  });
});

describe("writing a table row", () => {
  it("escapes a pipe inside a cell so the row keeps its cell count", () => {
    const row = tableRow(["path", "`pkg`", "none", "`printf 'x' | agent-chat spawn`"]);
    expect(row).toBe("| path | `pkg` | none | `printf 'x' \\| agent-chat spawn` |");
    expect(row.split(/(?<!\\)\|/)).toHaveLength(6);
  });
});

describe("writing and checking API snapshots", () => {
  const tempDirs = [];
  afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function fixtureRepo({ dist = true } = {}) {
    const repoRoot = mkdtempSync(join(tmpdir(), "gen-capabilities-"));
    tempDirs.push(repoRoot);
    const files = {
      "package.json": JSON.stringify({
        name: "@titan-design/hitl",
        exports: { ".": { types: "./dist/index.d.ts" }, "./sqlite": { types: "./dist/sqlite.d.ts" } },
      }),
      ...(dist && {
        "dist/index.d.ts": "export declare function openGate(): void;\nexport declare function waitGate(): void;\n",
        "dist/sqlite.d.ts": "export declare class SqliteGateStore {}\n",
      }),
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repoRoot, "packages", "hitl", file)), { recursive: true });
      writeFileSync(join(repoRoot, "packages", "hitl", file), text);
    }
    return repoRoot;
  }

  function generate(repoRoot, argv) {
    const errors = [];
    const catalog = () => [{ path: join(repoRoot, "CAPABILITIES.md"), text: "# catalog\n" }];
    const code = run(argv, { repoRoot, catalog, log: () => {}, error: (m) => errors.push(m) });
    return { code, errors };
  }

  it("writes a snapshot per exports entry, including the ./sqlite subpath, and then checks clean", () => {
    const repoRoot = fixtureRepo();
    expect(generate(repoRoot, []).code).toBe(0);
    expect(readFileSync(join(repoRoot, "packages", "hitl", "api", "sqlite.d.ts"), "utf8")).toContain("SqliteGateStore");
    expect(existsSync(join(repoRoot, "packages", "hitl", "api", "index.d.ts"))).toBe(true);
    expect(generate(repoRoot, ["--check"])).toEqual({ code: 0, errors: [] });
  });

  it("fails the check and names the snapshot after an export is removed", () => {
    const repoRoot = fixtureRepo();
    generate(repoRoot, []);
    writeFileSync(join(repoRoot, "packages", "hitl", "dist", "index.d.ts"), "export declare function openGate(): void;\n");
    const { code, errors } = generate(repoRoot, ["--check"]);
    expect(code).toBe(1);
    expect(errors).toEqual([expect.stringContaining(join("packages", "hitl", "api", "index.d.ts"))]);
  });

  describe("a snapshot whose exports entry is gone", () => {
    const pkgPath = (repoRoot) => join(repoRoot, "packages", "hitl", "package.json");
    const apiFile = (repoRoot, ...parts) => join(repoRoot, "packages", "hitl", "api", ...parts);

    function withoutSqliteEntry(repoRoot) {
      const pkg = JSON.parse(readFileSync(pkgPath(repoRoot), "utf8"));
      delete pkg.exports["./sqlite"];
      writeFileSync(pkgPath(repoRoot), JSON.stringify(pkg));
    }

    function withNestedEntry() {
      const repoRoot = fixtureRepo();
      const pkg = JSON.parse(readFileSync(pkgPath(repoRoot), "utf8"));
      pkg.exports["./limits/node"] = { types: "./dist/limits/node.d.ts" };
      writeFileSync(pkgPath(repoRoot), JSON.stringify(pkg));
      mkdirSync(join(repoRoot, "packages", "hitl", "dist", "limits"), { recursive: true });
      writeFileSync(join(repoRoot, "packages", "hitl", "dist", "limits", "node.d.ts"), "export declare const LIMIT: number;\n");
      generate(repoRoot, []);
      return repoRoot;
    }

    it("fails the check naming the orphan, and a plain run deletes it so a re-check passes", () => {
      const repoRoot = fixtureRepo();
      generate(repoRoot, []);
      withoutSqliteEntry(repoRoot);

      const { code, errors } = generate(repoRoot, ["--check"]);
      expect(code).toBe(1);
      expect(errors).toEqual([expect.stringContaining(join("packages", "hitl", "api", "sqlite.d.ts"))]);

      expect(generate(repoRoot, []).code).toBe(0);
      expect(existsSync(apiFile(repoRoot, "sqlite.d.ts"))).toBe(false);
      expect(existsSync(apiFile(repoRoot, "index.d.ts"))).toBe(true);
      expect(generate(repoRoot, ["--check"])).toEqual({ code: 0, errors: [] });
    });

    it("finds an orphan under a nested subpath", () => {
      const repoRoot = withNestedEntry();
      const pkg = JSON.parse(readFileSync(pkgPath(repoRoot), "utf8"));
      delete pkg.exports["./limits/node"];
      writeFileSync(pkgPath(repoRoot), JSON.stringify(pkg));

      const { code, errors } = generate(repoRoot, ["--check"]);
      expect(code).toBe(1);
      expect(errors).toEqual([expect.stringContaining(join("packages", "hitl", "api", "limits", "node.d.ts"))]);
      generate(repoRoot, []);
      expect(existsSync(apiFile(repoRoot, "limits", "node.d.ts"))).toBe(false);
    });

    it("flags every snapshot of a package turned private", () => {
      const repoRoot = fixtureRepo();
      generate(repoRoot, []);
      const pkg = JSON.parse(readFileSync(pkgPath(repoRoot), "utf8"));
      writeFileSync(pkgPath(repoRoot), JSON.stringify({ ...pkg, private: true }));

      const { code, errors } = generate(repoRoot, ["--check"]);
      expect(code).toBe(1);
      expect(errors).toHaveLength(2);
      generate(repoRoot, []);
      expect(generate(repoRoot, ["--check"])).toEqual({ code: 0, errors: [] });
      expect(existsSync(apiFile(repoRoot, "index.d.ts"))).toBe(false);
    });

    it("with --catalog-only neither flags nor deletes the orphan", () => {
      const repoRoot = fixtureRepo();
      generate(repoRoot, []);
      withoutSqliteEntry(repoRoot);

      expect(generate(repoRoot, ["--catalog-only"]).code).toBe(0);
      expect(existsSync(apiFile(repoRoot, "sqlite.d.ts"))).toBe(true);
      expect(generate(repoRoot, ["--catalog-only", "--check"])).toEqual({ code: 0, errors: [] });
    });
  });

  it("exits 2 naming the package when dist is missing", () => {
    const { code, errors } = generate(fixtureRepo({ dist: false }), ["--check"]);
    expect(code).toBe(2);
    expect(errors).toEqual([expect.stringMatching(/@titan-design\/hitl.*pnpm build/)]);
  });

  it("with --catalog-only writes just the catalog and needs no dist", () => {
    const repoRoot = fixtureRepo({ dist: false });
    expect(generate(repoRoot, ["--catalog-only"]).code).toBe(0);
    expect(existsSync(join(repoRoot, "CAPABILITIES.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "packages", "hitl", "api"))).toBe(false);
  });
});
