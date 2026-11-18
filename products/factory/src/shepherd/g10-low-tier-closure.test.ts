import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lowTierPolicyTouch } from "./g10-low-tier.js";
import { fixtureRepo, lowTierClosure, repoTree } from "./g10-low-tier-closure.test-helpers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** The refusal's entry points: the classifier, and the hold that reads the files and line counts it judges. */
const SEEDS = ["products/factory/src/shepherd/g10-low-tier.ts", "products/factory/src/shepherd/registration-hold.ts"];
/** In the hold closure only: a path that goes low on its own. */
const HOLD_CLOSURE_PATH = "products/factory/src/shepherd/wake-loop.ts";

/** The gate inputs the round-two reviews found outside the hand-written list this closure replaced. */
const FOUND_GOING_LOW = [
  ...["review-panel/src/glob.ts", "review-panel/src/index.ts", "fix-proof/src/glob.ts"].map((name) => `packages/${name}`),
  ...["git-pr-files.ts", "reviewer-roles.ts", "visual-gate-mode.ts", "visual-gate.ts"].map((name) => `products/factory/src/shepherd/${name}`),
];

const lowBeside = (path: string): boolean => lowTierPolicyTouch({ paths: [HOLD_CLOSURE_PATH, path], changedLines: 10, unread: undefined, ownerHold: undefined }).eligible;

describe("the low-tier refusal's own import closure", () => {
  const closure = lowTierClosure(repoTree(REPO_ROOT), SEEDS);

  it("keeps every file the walk reaches out of low tier", () => {
    expect(lowBeside("packages/store/src/a.ts")).toBe(true);
    expect(closure.reached.filter(lowBeside)).toEqual([]);
  });

  it("keeps the refusal closure list equal to the walk", async () => {
    await expect(`${JSON.stringify(closure.reached, null, 2)}\n`).toMatchFileSnapshot("./g10-low-tier-closure.json");
  });

  it("resolves every relative and workspace import it follows, so none drops out of the walk", () => {
    expect(closure.unresolved).toEqual([]);
  });

  it("keeps its own completeness check out of low tier", () => {
    const checks = ["g10-low-tier-closure.test.ts", "g10-low-tier-closure.test.mutations.json", "g10-low-tier-closure.test-helpers.ts"].map((name) => `products/factory/src/shepherd/${name}`);

    expect(checks.filter(lowBeside)).toEqual([]);
  });

  it.each(FOUND_GOING_LOW)("keeps %s, which an adversary review found going low", (path) => {
    expect(closure.reached).toContain(path);
    expect(lowBeside(path)).toBe(false);
  });
});

describe("the low-tier refusal closure on a synthetic repository", () => {
  const files = {
    "products/factory/src/shepherd/g10-low-tier.ts": `import { matches } from "@titan-design/panel";\nimport type { T } from "./types.js";\nexport const x = matches;`,
    "products/factory/src/shepherd/types.ts": `export type T = number;`,
    "packages/panel/package.json": JSON.stringify({ name: "@titan-design/panel", exports: { ".": { import: "./dist/index.js" }, "./node": { import: "./dist/node.js" } } }),
    "packages/panel/src/index.ts": `export { matches } from "./glob.js";\nimport "zod";\nimport "@titan-design/from-npm";`,
    "packages/panel/src/glob.ts": `export const matches = () => true;`,
    "packages/panel/src/node/index.ts": `export const node = 1;`,
    "products/factory/src/shepherd/stray.ts": `import { x } from "./g10-low-tier.js";\nexport const y = x;`,
  };
  const tree = fixtureRepo("/repo", files, { "@titan-design/panel": "packages/panel" });

  it("crosses into a workspace package's source and walks it, type imports included", () => {
    expect(lowTierClosure(tree, ["products/factory/src/shepherd/g10-low-tier.ts"])).toEqual({
      reached: ["packages/panel/src/glob.ts", "packages/panel/src/index.ts", "products/factory/src/shepherd/g10-low-tier.ts", "products/factory/src/shepherd/types.ts"],
      unresolved: [],
    });
  });

  it("resolves a subpath export built from a directory index", () => {
    const withNode = fixtureRepo("/repo", { ...files, "products/factory/src/a.ts": `import "@titan-design/panel/node";` }, { "@titan-design/panel": "packages/panel" });

    expect(lowTierClosure(withNode, ["products/factory/src/a.ts"]).reached).toContain("packages/panel/src/node/index.ts");
  });

  it("leaves out a module that only imports the refusal", () => {
    expect(lowTierClosure(tree, ["products/factory/src/shepherd/g10-low-tier.ts"]).reached).not.toContain("products/factory/src/shepherd/stray.ts");
  });

  it("reports an import it cannot resolve", () => {
    const source = { "products/factory/src/a.ts": `import "./gone.js";\nimport "@titan-design/panel/missing";`, "packages/panel/package.json": files["packages/panel/package.json"] };
    const broken = fixtureRepo("/repo", source, { "@titan-design/panel": "packages/panel" });

    expect(lowTierClosure(broken, ["products/factory/src/a.ts"]).unresolved).toEqual(["products/factory/src/a.ts -> ./gone.js", "products/factory/src/a.ts -> @titan-design/panel/missing"]);
  });
});
