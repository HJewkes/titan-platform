import { describe, expect, it } from "vitest";
import type { ChangedFile, FileStatus } from "./config.js";
import { doorFacts, type ChangesetBump } from "./door.js";
import { burdenScore, scoreParts, unitOf, type BurdenFacts, type BurdenInput, type BurdenParts } from "./score.js";
import fixtures from "./__fixtures__/prs.json" with { type: "json" };

const NONE: BurdenFacts = {
  productionLines: 0,
  testLines: 0,
  productionFiles: 0,
  units: [],
  api: false,
  migration: false,
  runtimeDeps: 0,
  devDeps: 0,
  footer: true,
  contract: true,
};

function partOf(part: keyof BurdenParts, facts: Partial<BurdenFacts>): number {
  return scoreParts({ ...NONE, ...facts })[part];
}

function units(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `packages/u${index}`);
}

describe("scoreParts: one row at a time", () => {
  it.each([
    [0, 0], [10, 3], [50, 10], [150, 20], [350, 30], [10_000, 30],
  ])("size: %i production lines score %i", (productionLines, points) => {
    expect(partOf("size", { productionLines })).toBe(points);
  });

  it.each([
    [0, 0, 0], [1, 1, 0], [4, 1, 3], [11, 1, 10], [30, 1, 10], [2, 2, 6], [3, 3, 12], [12, 3, 20], [40, 9, 20],
  ])("spread: %i files in %i units score %i", (productionFiles, unitCount, points) => {
    expect(partOf("spread", { productionFiles, units: units(unitCount) })).toBe(points);
  });

  it.each([
    [10, 0, 0], [11, 0, 15], [100, 19, 10], [100, 20, 5], [100, 49, 5], [100, 50, 0], [100, 300, 0],
  ])("tests: %i production and %i test lines score %i", (productionLines, testLines, points) => {
    expect(partOf("tests", { productionLines, testLines })).toBe(points);
  });

  it.each([
    [0, 10], [1, 6], [2, 3], [3, 0], [undefined, 0],
  ])("tier: tier %s scores %i", (tier, points) => {
    expect(partOf("tier", tier === undefined ? {} : { tier })).toBe(points);
  });

  it.each([
    ["api", { api: true }, 10], ["api", { api: false }, 0],
    ["migration", { migration: true }, 15], ["migration", { migration: false }, 0],
    ["rationale", { footer: false }, 10], ["rationale", { footer: true }, 0],
    ["contract", { contract: false }, 5], ["contract", { contract: true }, 0],
  ] as const)("%s: %o scores %i", (part, facts, points) => {
    expect(partOf(part, facts)).toBe(points);
  });

  it.each([
    [0, 0, 0], [1, 0, 5], [0, 1, 2], [1, 2, 9], [2, 0, 10], [0, 6, 10],
  ])("deps: %i runtime and %i dev adds score %i", (runtimeDeps, devDeps, points) => {
    expect(partOf("deps", { runtimeDeps, devDeps })).toBe(points);
  });
});

function change(path: string, additions: number, deletions = 0, status: ChangedFile["status"] = "modified"): ChangedFile {
  return { path, status, additions, deletions };
}

describe("burdenScore", () => {
  it("caps the total at 100 while printing every part", () => {
    const score = burdenScore({
      files: [change("packages/a/src/index.ts", 900), change("packages/b/src/migrations/1.sql", 100), change("packages/c/src/x.ts", 100)],
      tiers: { "0": ["packages/a"] },
      packageJsons: [{ path: "packages/a/package.json", base: {}, head: { dependencies: { zod: "^3" }, devDependencies: { tsup: "^8" } } }],
      body: "no footer",
    });

    expect(score.parts).toEqual({ size: 30, spread: 12, tests: 15, tier: 10, api: 10, migration: 15, deps: 7, rationale: 10, contract: 5 });
    expect(score.total).toBe(100);
  });

  it("counts test and ignored lines apart from production", () => {
    const facts = burdenScore({
      files: [change("src/a/x.ts", 30, 10), change("src/a/x.test.ts", 50, 5), change("pnpm-lock.yaml", 400), change("CHANGELOG.md", 9)],
      body: "",
    }).facts;

    expect(facts).toMatchObject({ productionLines: 40, testLines: 55, productionFiles: 1, units: ["src/a"] });
  });

  it("reads the lowest numbered tier a production file touches, skipping named tiers and test-only units", () => {
    const tiers = { "0": ["packages/base"], "1": ["packages/engine"], "2": ["packages/domain"], product: ["products/app"] };
    const files = [change("packages/domain/src/x.ts", 5), change("packages/engine/src/y.ts", 5), change("products/app/src/z.ts", 5), change("packages/base/src/w.test.ts", 5)];

    expect(burdenScore({ files, tiers, body: "" }).facts.tier).toBe(1);
    expect(burdenScore({ files: [change("products/app/src/z.ts", 5)], tiers, body: "" }).facts.tier).toBeUndefined();
  });

  it("marks api from an index entry, a help golden, a tool-name fixture or a changed exports map", () => {
    const api = (input: Partial<BurdenInput>) => burdenScore({ files: [], body: "", ...input }).facts.api;

    expect(api({ files: [change("packages/a/src/index.ts", 1)] })).toBe(true);
    expect(api({ files: [change("test/golden/help.txt", 1)] })).toBe(true);
    expect(api({ files: [change("test/__fixtures__/mcp-tool-names.json", 1)] })).toBe(true);
    expect(api({ packageJsons: [{ path: "package.json", base: { exports: { ".": "./a.js" } }, head: { exports: { ".": "./b.js" } } }] })).toBe(true);
    expect(api({ packageJsons: [{ path: "package.json", base: { bin: { a: "a", b: "b" } }, head: { bin: { b: "b", a: "a" } } }] })).toBe(false);
    expect(api({ files: [change("packages/a/src/inner/index.ts", 1)] })).toBe(false);
  });

  it("counts only dependency keys that are new on head", () => {
    const facts = burdenScore({
      files: [],
      packageJsons: [
        { path: "a/package.json", base: { dependencies: { zod: "^3" } }, head: { dependencies: { zod: "^4", hono: "^4" }, devDependencies: { tsup: "^8" } } },
        { path: "b/package.json", head: { dependencies: { zod: "^3" } } },
      ],
      body: "",
    }).facts;

    expect([facts.runtimeDeps, facts.devDeps]).toEqual([2, 1]);
  });
});

describe("unitOf", () => {
  it.each([
    ["packages/ledger/src/x.ts", ["packages/ledger"]],
    ["products/console/package.json", ["products/console"]],
    ["apps/web/src/main.tsx", ["apps/web"]],
    ["src/cli/status.ts", ["src/cli"]],
    ["src/index.ts", ["src"]],
    [".codewatch/check.json", [".codewatch"]],
    ["package.json", []],
  ])("puts %s in %o", (path, expected) => {
    expect(unitOf(change(path, 1))).toEqual(expected);
  });
});

const STATUSES: readonly string[] = ["added", "modified", "removed", "renamed", "copied"];
const BUMPS: readonly string[] = ["major", "minor", "patch"];

function isStatus(status: string): status is FileStatus {
  return STATUSES.includes(status);
}

function isBump(bump: string): bump is ChangesetBump {
  return BUMPS.includes(bump);
}

// JSON widens the string unions, so each one is checked rather than cast.
function inputOf(fixture: (typeof fixtures)[number]): BurdenInput {
  const files = fixture.input.files.map((file) => {
    if (!isStatus(file.status)) throw new Error(`${fixture.id}: unknown status ${file.status}`);
    return { ...file, status: file.status };
  });
  return { ...fixture.input, files };
}

describe("fixtures shaped like the six sample pull requests", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))("%s keeps its line totals, door and fixed score", (_id, fixture) => {
    const input = inputOf(fixture);
    const sum = (key: "additions" | "deletions") => input.files.reduce((total, file) => total + file[key], 0);

    expect({ additions: sum("additions"), deletions: sum("deletions"), files: input.files.length }).toEqual(fixture.lines);
    expect(doorFacts({ ...input, changesetBumps: fixture.changesetBumps.filter(isBump) }).door).toBe(fixture.door);
    expect(burdenScore(input)).toMatchObject(fixture.expected);
  });
});
