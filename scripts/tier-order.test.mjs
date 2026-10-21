import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layersFromTiers } from "./new-package.mjs";

const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workspace(importer, imported) {
  const root = mkdtempSync(path.join(tmpdir(), "tier-order-"));
  dirs.push(root, `${root}.db`);
  for (const dir of [importer, imported]) mkdirSync(path.join(root, dir, "src"), { recursive: true });
  writeFileSync(path.join(root, imported, "src/index.ts"), "export const value = 1;\n");
  const relative = path.relative(path.join(importer, "src"), path.join(imported, "src/index"));
  writeFileSync(path.join(root, importer, "src/index.ts"), `import { value } from "${relative}";\nexport const doubled = value * 2;\n`);
  return root;
}

async function layerViolations(root, tiers) {
  const graph = await import(ENTRY.href);
  const store = graph.openCodeGraph(path.join(root, "..", `${path.basename(root)}.db`));
  await graph.indexPaths(store, { paths: [root], ref: "head", computeChurn: false });
  const rules = [{ id: "package-layers", type: "layered-deps", layers: layersFromTiers(tiers) }];
  const run = graph.checkSnapshot(store, { snapshot: "head", rules });
  store.close();
  return run.result.violations;
}

const tiers = { 2: ["packages/engine"], 3: ["packages/flow"] };

describe("tier 3 enforcement through the layered-deps rule", () => {
  it("fails a tier-2 package that imports a tier-3 package", async () => {
    const root = workspace("packages/engine", "packages/flow");

    const violations = await layerViolations(root, tiers);

    expect(violations.map((v) => v.ruleId)).toEqual(["package-layers"]);
  }, 60_000);

  it("allows a tier-3 package to import a tier-2 package", async () => {
    const root = workspace("packages/flow", "packages/engine");

    expect(await layerViolations(root, tiers)).toEqual([]);
  }, 60_000);
});
