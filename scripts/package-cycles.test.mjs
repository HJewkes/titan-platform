import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCycles, packageGraph } from "./package-cycles.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workspace(packages) {
  const root = mkdtempSync(path.join(tmpdir(), "package-cycles-"));
  dirs.push(root);
  for (const [name, { deps = [], imports = [] }] of Object.entries(packages)) {
    const dir = path.join(root, "packages", name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    const dependencies = Object.fromEntries(deps.map((d) => [`@scope/${d}`, "workspace:*"]));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@scope/${name}`, dependencies }));
    const lines = imports.map((i) => `import "@scope/${i}";`);
    writeFileSync(path.join(dir, "src/index.ts"), `${lines.join("\n")}\nexport {};\n`);
  }
  return root;
}

describe("workspace package cycles", () => {
  it("reports two packages that depend on each other in package.json", () => {
    const root = workspace({ a: { deps: ["b"] }, b: { deps: ["a"] } });

    expect(findCycles(packageGraph(root))).toEqual([["@scope/a", "@scope/b"]]);
  });

  it("reports two packages that only import each other in source", () => {
    const root = workspace({ a: { imports: ["b"] }, b: { imports: ["a"] } });

    expect(findCycles(packageGraph(root))).toEqual([["@scope/a", "@scope/b"]]);
  });

  it("reports a longer cycle as one component", () => {
    const root = workspace({ a: { deps: ["b"] }, b: { deps: ["c"] }, c: { deps: ["a"] }, d: { deps: ["a"] } });

    expect(findCycles(packageGraph(root))).toEqual([["@scope/a", "@scope/b", "@scope/c"]]);
  });

  it("passes once the cycle is broken", () => {
    const root = workspace({ a: { deps: ["b"] }, b: {} });

    expect(findCycles(packageGraph(root))).toEqual([]);
  });
});
