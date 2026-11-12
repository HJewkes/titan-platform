import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);
const CHECK = new URL("../.codewatch/check.json", import.meta.url);
const SRC = "products/active-work/src";
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function layerRule() {
  const { rules } = JSON.parse(readFileSync(CHECK, "utf8"));
  return rules.find((rule) => rule.id === "active-work-layers");
}

/** A tree where `importer` (a path under src) imports `imported`. */
function tree(importer, imported) {
  const root = mkdtempSync(path.join(tmpdir(), "aw-layers-"));
  dirs.push(root, `${root}.db`);
  for (const file of [importer, imported]) mkdirSync(path.dirname(path.join(root, SRC, file)), { recursive: true });
  writeFileSync(path.join(root, SRC, imported), "export const value = 1;\n");
  const relative = path.relative(path.dirname(path.join(SRC, importer)), path.join(SRC, imported)).replace(/\.ts$/, ".js");
  writeFileSync(path.join(root, SRC, importer), `import { value } from "./${relative}";\nexport const doubled = value * 2;\n`);
  return root;
}

async function violations(root) {
  const graph = await import(ENTRY.href);
  const store = graph.openCodeGraph(`${root}.db`);
  await graph.indexPaths(store, { paths: [root], ref: "head", computeChurn: false });
  const run = graph.checkSnapshot(store, { snapshot: "head", rules: [layerRule()] });
  store.close();
  return run.result.violations.map((v) => `${v.nodeId} -> ${v.destinationId}`);
}

describe("the active-work-layers rule in .codewatch/check.json", () => {
  it("fails a store module that imports a command", async () => {
    const root = tree("sessions/x.ts", "commands/y.ts");

    expect(await violations(root)).toEqual([`${SRC}/sessions/x.ts -> ${SRC}/commands/y.ts`]);
  }, 60_000);

  it("fails a base util that imports a service", async () => {
    const root = tree("utils/x.ts", "discover/y.ts");

    expect(await violations(root)).toEqual([`${SRC}/utils/x.ts -> ${SRC}/discover/y.ts`]);
  }, 60_000);

  it("allows a command to import the store", async () => {
    const root = tree("commands/y.ts", "sessions/x.ts");

    expect(await violations(root)).toEqual([]);
  }, 60_000);

  it("lets a colocated test reach across layers", async () => {
    const root = tree("sessions/x.test.ts", "commands/y.ts");

    expect(await violations(root)).toEqual([]);
  }, 60_000);
});
