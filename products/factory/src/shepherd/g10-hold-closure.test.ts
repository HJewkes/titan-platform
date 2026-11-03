import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathTouches, type ClassRules } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { SHEPHERD_CLASS_RULES, SHEPHERD_LISTED_RULES, withHoldClosure } from "./g10-class-rules.js";
import { fixtureTree, holdClosure, shepherdTree, type ShepherdTree } from "./g10-hold-closure.test-helpers.js";
import { adversaryTouches } from "./signoffs.js";

const SHEPHERD_DIR = dirname(fileURLToPath(import.meta.url));
const inShepherd = (name: string): string => `products/factory/src/shepherd/${name}`;

const heldBy = (rules: ClassRules, name: string): boolean => adversaryTouches(pathTouches([{ path: inShepherd(name) }], rules)).length > 0;

/** Every Shepherd module the listed table holds: the walk starts from all of them, not from a few roots. */
const listedSeeds = (tree: ShepherdTree): string[] => tree.names.filter((name) => heldBy(SHEPHERD_LISTED_RULES, name));

/** The closure less what the table already lists: the names `g10-hold-closure.json` must hold. */
function closureBeyondListed(tree: ShepherdTree): string[] {
  return holdClosure(tree, listedSeeds(tree)).reached.filter((name) => !heldBy(SHEPHERD_LISTED_RULES, name));
}

describe("the G10 hold closure of Shepherd's listed policy modules", () => {
  const tree = shepherdTree(SHEPHERD_DIR);
  const closure = holdClosure(tree, listedSeeds(tree));

  it("holds g10-adversary every module the walk reaches", () => {
    expect(closure.reached.filter((name) => !heldBy(SHEPHERD_CLASS_RULES, name))).toEqual([]);
  });

  it("keeps the held closure list equal to the walk", async () => {
    await expect(`${JSON.stringify(closureBeyondListed(tree), null, 2)}\n`).toMatchFileSnapshot("./g10-hold-closure.json");
  });

  it("resolves every relative import it follows, so none drops out of the walk", () => {
    expect(closure.unresolved).toEqual([]);
  });

  it.each(["registration-of.ts", "proof-waiver.ts", "seat-recheck.ts", "carry-merge.ts", "merge-up-carry.ts"])("holds %s, which an adversary review found unheld", (name) => {
    expect(tree.names).toContain(name);
    expect(heldBy(SHEPHERD_CLASS_RULES, name)).toBe(true);
  });
});

describe("the G10 hold closure on a synthetic Shepherd directory", () => {
  const files = {
    "signoffs.ts": `import type { Fresh } from "./fresh-helper.js";\nexport const x: Fresh = 1;`,
    "fresh-helper.ts": `export { deeper } from "./fresh-deeper.js";\nexport type Fresh = number;`,
    "fresh-deeper.ts": `export const deeper = 2;`,
    "fresh-stray.ts": `import { x } from "./signoffs.js";\nexport const y = x;`,
  };
  const tree = fixtureTree(SHEPHERD_DIR, files);

  it("holds a new module a held module imports by type, and what it re-exports, with no table edit", () => {
    const rules = withHoldClosure(closureBeyondListed(tree));

    expect(heldBy(SHEPHERD_LISTED_RULES, "fresh-helper.ts")).toBe(false);
    expect(heldBy(rules, "fresh-helper.ts")).toBe(true);
    expect(heldBy(rules, "fresh-deeper.ts")).toBe(true);
  });

  it("leaves a module that only imports a held one unheld", () => {
    expect(heldBy(withHoldClosure(closureBeyondListed(tree)), "fresh-stray.ts")).toBe(false);
  });

  it("reports a relative import it cannot resolve", () => {
    const broken = fixtureTree(SHEPHERD_DIR, { "signoffs.ts": `import "./gone.js";` });

    expect(holdClosure(broken, ["signoffs.ts"]).unresolved).toEqual(["signoffs.ts -> ./gone.js"]);
  });
});
