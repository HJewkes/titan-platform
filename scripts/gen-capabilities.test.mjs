import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { keyExports, parseExports, parseUseWhen, run, tableRow } from "./gen-capabilities.mjs";

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
  it("drops the heading and the authoring comment and joins the prose onto one line", () => {
    const markdown = "# agent: use this when\n\n<!-- guidance for authors -->\n\nYou run one agent.\nIt needs a token.\n";
    expect(parseUseWhen(markdown)).toBe("You run one agent. It needs a token.");
  });

  it("ships in the package template so every stamped package starts with one", () => {
    const template = readFileSync(join(REPO, "templates", "package", "CAPABILITY.md"), "utf8");
    expect(parseUseWhen(template)).toContain("__NAME__");
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
