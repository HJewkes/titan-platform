import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathTouches, type ClassRules } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { SHEPHERD_CLASS_RULES, SHEPHERD_LISTED_RULES, withHoldClosure } from "./g10-class-rules.js";
import { factoryTree, fixtureTree, holdClosure, type SourceTree } from "./g10-hold-closure.test-helpers.js";
import { adversaryTouches } from "./signoffs.js";

const FACTORY_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const inFactorySrc = (name: string): string => `products/factory/src/${name}`;

const heldBy = (rules: ClassRules, name: string): boolean => adversaryTouches(pathTouches([{ path: inFactorySrc(name) }], rules)).length > 0;

/** Every factory module the listed table holds: the walk starts from all of them, not from a few roots. */
const listedSeeds = (tree: SourceTree): string[] => tree.names.filter((name) => heldBy(SHEPHERD_LISTED_RULES, name));

/** The closure less what the table already lists: the names `g10-hold-closure.json` must hold. */
function closureBeyondListed(tree: SourceTree): string[] {
  return holdClosure(tree, listedSeeds(tree)).reached.filter((name) => !heldBy(SHEPHERD_LISTED_RULES, name));
}

/** Every module the walk reaches that the rules leave unheld: empty when the closure list is current. */
const unheldReached = (tree: SourceTree, rules: ClassRules): string[] => holdClosure(tree, listedSeeds(tree)).reached.filter((name) => !heldBy(rules, name));

describe("the G10 hold closure of the factory's listed policy modules", () => {
  const tree = factoryTree(FACTORY_SRC);
  const closure = holdClosure(tree, listedSeeds(tree));

  it("holds g10-adversary every module the walk reaches", () => {
    expect(unheldReached(tree, SHEPHERD_CLASS_RULES)).toEqual([]);
  });

  it("keeps the held closure list equal to the walk", async () => {
    await expect(`${JSON.stringify(closureBeyondListed(tree), null, 2)}\n`).toMatchFileSnapshot("./g10-hold-closure.json");
  });

  it("resolves every relative import it follows, so none drops out of the walk", () => {
    expect(closure.unresolved).toEqual([]);
  });

  it.each(["registration-of.ts", "proof-waiver.ts", "seat-recheck.ts", "carry-merge.ts", "merge-up-carry.ts"])("holds %s, which an adversary review found unheld", (name) => {
    expect(tree.names).toContain(`shepherd/${name}`);
    expect(heldBy(SHEPHERD_CLASS_RULES, `shepherd/${name}`)).toBe(true);
  });

  it("holds owner-at-head.ts, which approval-carry.ts imports from outside shepherd/", () => {
    expect(heldBy(SHEPHERD_LISTED_RULES, "shepherd/approval-carry.ts")).toBe(true);
    expect(heldBy(SHEPHERD_LISTED_RULES, "owner-at-head.ts")).toBe(false);
    expect(closure.reached).toContain("owner-at-head.ts");
    expect(heldBy(SHEPHERD_CLASS_RULES, "owner-at-head.ts")).toBe(true);
  });
});

describe("the G10 hold closure on a synthetic factory source tree", () => {
  const files = {
    "shepherd/signoffs.ts": `import type { Fresh } from "./fresh-helper.js";\nexport const x: Fresh = 1;`,
    "shepherd/fresh-helper.ts": `export { deeper } from "./fresh-deeper.js";\nexport type Fresh = number;`,
    "shepherd/fresh-deeper.ts": `export const deeper = 2;`,
    "shepherd/fresh-stray.ts": `import { x } from "./signoffs.js";\nexport const y = x;`,
    "widgets/coordinator-evidence-sample.ts": `import { rowsOf } from "../sample-rows.js";\nexport const rows = rowsOf();`,
    "sample-rows.ts": `import { parse } from "./parsing/sample-parse.js";\nexport const rowsOf = () => parse();`,
    "parsing/sample-parse.ts": `export const parse = () => [];`,
  };
  const tree = fixtureTree(FACTORY_SRC, files);

  it("holds a new module a held module imports by type, and what it re-exports, with no table edit", () => {
    const rules = withHoldClosure(closureBeyondListed(tree));

    expect(heldBy(SHEPHERD_LISTED_RULES, "shepherd/fresh-helper.ts")).toBe(false);
    expect(heldBy(rules, "shepherd/fresh-helper.ts")).toBe(true);
    expect(heldBy(rules, "shepherd/fresh-deeper.ts")).toBe(true);
  });

  it("holds a helper that a held coordinator-evidence file imports", () => {
    const rules = withHoldClosure(closureBeyondListed(tree));

    expect(heldBy(SHEPHERD_LISTED_RULES, "widgets/coordinator-evidence-sample.ts")).toBe(true);
    expect(heldBy(SHEPHERD_LISTED_RULES, "sample-rows.ts")).toBe(false);
    expect(heldBy(rules, "sample-rows.ts")).toBe(true);
    expect(heldBy(rules, "parsing/sample-parse.ts")).toBe(true);
  });

  it("fails when a held file imports a factory module the closure does not list", () => {
    const stale = withHoldClosure(closureBeyondListed(tree).filter((name) => name !== "sample-rows.ts"));

    expect(unheldReached(tree, stale)).toEqual(["sample-rows.ts"]);
  });

  it("leaves a module that only imports a held one unheld", () => {
    expect(heldBy(withHoldClosure(closureBeyondListed(tree)), "shepherd/fresh-stray.ts")).toBe(false);
  });

  it("reports a relative import it cannot resolve", () => {
    const broken = fixtureTree(FACTORY_SRC, { "shepherd/signoffs.ts": `import "./gone.js";` });

    expect(holdClosure(broken, ["shepherd/signoffs.ts"]).unresolved).toEqual(["shepherd/signoffs.ts -> ./gone.js"]);
  });
});
