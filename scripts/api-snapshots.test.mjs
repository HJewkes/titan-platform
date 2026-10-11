import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MissingDistError, entriesOf, normalizeDts, packageSnapshots, snapshotOutputs } from "./api-snapshots.mjs";

const tempDirs = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const HITL_EXPORTS = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  "./sqlite": { types: "./dist/sqlite.d.ts", import: "./dist/sqlite.js" },
};

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function fixtureRepo(packages) {
  const root = mkdtempSync(join(tmpdir(), "api-snapshots-"));
  tempDirs.push(root);
  for (const [dir, files] of Object.entries(packages)) write(join(root, "packages", dir), files);
  return root;
}

function hitlPackage(dist = {}) {
  return {
    "package.json": JSON.stringify({ name: "@titan-design/hitl", exports: HITL_EXPORTS }),
    "dist/index.d.ts": "import { G as Gate } from './store-DsOXg04w.js';\nexport declare function openGate(): Gate;\nexport declare function waitGate(): void;\n",
    "dist/sqlite.d.ts": "export declare class SqliteGateStore {}\n",
    "dist/store-DsOXg04w.d.ts": "interface Gate { id: string }\nexport { Gate as G };\n",
    ...dist,
  };
}

const snapshotOf = (root, entry) => snapshotOutputs(root).find((s) => s.path.endsWith(join("hitl", "api", entry)));

describe("naming a package's exports entries", () => {
  it("names the root entry index and a subpath by its path, skipping entries with no types", () => {
    const pkg = { exports: { ...HITL_EXPORTS, "./limits/node": { types: "./dist/limits/node.d.ts" }, "./table.json": "./src/table.json" } };
    expect(entriesOf(pkg)).toEqual([
      { name: "index", types: "./dist/index.d.ts" },
      { name: "sqlite", types: "./dist/sqlite.d.ts" },
      { name: "limits/node", types: "./dist/limits/node.d.ts" },
    ]);
  });
});

describe("normalizing a declaration file", () => {
  it("drops the source map comment and trailing spaces", () => {
    expect(normalizeDts("export declare const a = 1;   \n//# sourceMappingURL=index.d.ts.map\n")).toBe("export declare const a = 1;\n");
  });

  it("gives two builds with different chunk hashes the same text", () => {
    const first = "import { G as Gate } from './base-store-DsOXg04w.js';\nexport * from '../snapshot-Cy4-1G8Q.js';\n";
    const second = "import { G as Gate } from './base-store-Ab3_x9Qz.js';\nexport * from '../snapshot-Zz9_aB7k.js';\n";
    expect(normalizeDts(first)).toBe(normalizeDts(second));
    expect(normalizeDts(first)).toContain("from './base-store.js'");
  });

  it("keeps a hyphenated module name that carries no hash", () => {
    expect(normalizeDts("export * from './change-coupling.js';\n")).toBe("export * from './change-coupling.js';\n");
  });
});

describe("snapshotting the packages of a repository", () => {
  it("writes one snapshot per exports entry, with the shared chunk the entry reaches inlined", () => {
    const root = fixtureRepo({ hitl: hitlPackage() });
    const outputs = snapshotOutputs(root);
    expect(outputs.map((s) => s.path)).toEqual([join(root, "packages/hitl/api/index.d.ts"), join(root, "packages/hitl/api/sqlite.d.ts")]);
    expect(outputs[0].text).toContain("// ./dist/store.d.ts\ninterface Gate { id: string }");
    expect(outputs[1].text).toBe("export declare class SqliteGateStore {}\n");
  });

  it("yields nothing for a private package", () => {
    const root = fixtureRepo({ hitl: { ...hitlPackage(), "package.json": JSON.stringify({ name: "x", private: true, exports: HITL_EXPORTS }) } });
    expect(snapshotOutputs(root)).toEqual([]);
  });

  it("names the package and pnpm build when a declared types file was never built", () => {
    const root = fixtureRepo({ hitl: { "package.json": JSON.stringify({ name: "@titan-design/hitl", exports: HITL_EXPORTS }) } });
    expect(() => snapshotOutputs(root)).toThrow(MissingDistError);
    expect(() => snapshotOutputs(root)).toThrow(/@titan-design\/hitl: \.\/dist\/index\.d\.ts is missing\. Run pnpm build/);
  });

  it("changes the snapshot when an export is removed", () => {
    const before = snapshotOf(fixtureRepo({ hitl: hitlPackage() }), "index.d.ts");
    const after = snapshotOf(fixtureRepo({ hitl: hitlPackage({ "dist/index.d.ts": "import { G as Gate } from './store-DsOXg04w.js';\nexport declare function openGate(): Gate;\n" }) }), "index.d.ts");
    expect(after.text).not.toBe(before.text);
  });

  it("changes the snapshot when a type in a shared chunk changes", () => {
    const before = snapshotOf(fixtureRepo({ hitl: hitlPackage() }), "index.d.ts");
    const after = snapshotOf(fixtureRepo({ hitl: hitlPackage({ "dist/store-DsOXg04w.d.ts": "interface Gate { id: number }\nexport { Gate as G };\n" }) }), "index.d.ts");
    expect(after.text).not.toBe(before.text);
  });

  it("leaves another entry's file to that entry's own snapshot", () => {
    const pkgDir = join(fixtureRepo({ hitl: hitlPackage({ "dist/index.d.ts": "export * from './sqlite.js';\n" }) }), "packages", "hitl");
    expect(packageSnapshots(pkgDir)[0].text).toBe("export * from './sqlite.js';\n");
  });
});
