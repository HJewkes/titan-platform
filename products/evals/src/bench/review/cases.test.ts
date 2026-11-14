import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BundleGit } from "../../review-pr/bundle.js";
import { CASE_TYPES, interleave, loadCasesV1, stratifiedQueue, type CaseType, type ReviewCaseBody } from "./cases.js";
import { plantControls, plantOn } from "./plant.js";
import { buildReviewSample } from "./sample.js";

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);
const TEST_FILE = ["it('adds', () => {", "  expect(add(1, 2)).toBe(3);", "});"].join("\n");
const SOURCE_FILE = ["export function clamp(x: number) {", "  if (x > 10) {", "    return 10;", "  }", "  return x;", "}"].join("\n");

const body = (id: string, caseType: CaseType, extra: Partial<ReviewCaseBody> = {}): ReviewCaseBody => ({
  id,
  caseType,
  kind: "feature",
  repo: "acme/widgets",
  pr: 1,
  head: sha(id.slice(-1)),
  base: sha("0"),
  split: "dev",
  gold: [],
  ...extra,
});

/** A clone holding every head it is given, each changing a test file and a source file. */
function fakeGit(heads: ReadonlySet<string>): BundleGit {
  return {
    git: (args) => {
      const [verb, ...rest] = args;
      if (verb === "diff") return Promise.resolve(Buffer.from("src/clamp.ts\nsrc/add.test.ts\n"));
      if (verb === "show") return Promise.resolve(Buffer.from(rest[0]?.endsWith(".test.ts") ? TEST_FILE : SOURCE_FILE));
      if (verb === "cat-file") return heads.has((rest[1] ?? "").slice(0, 40)) ? Promise.resolve(Buffer.from("")) : Promise.reject(new Error("absent"));
      return Promise.resolve(Buffer.from(".git"));
    },
  };
}

describe("planted controls", () => {
  const cleans = ["c1", "c2", "c3", "c4"].map((id) => body(id, "clean"));
  const git = fakeGit(new Set());

  it("rotate kinds and give each clean head at most one plant", async () => {
    const planted = await plantControls(cleans, 4, () => git);
    expect(planted.map((control) => control.plant?.kind)).toEqual(["deleted-assertion", "inverted-condition", "toothless-test", "deleted-assertion"]);
    expect(new Set(planted.map((control) => control.plantedOn)).size).toBe(4);
  });

  it("carry the planted path and line as gold", async () => {
    const control = await plantOn(body("c1", "clean"), "inverted-condition", git);
    expect(control).toMatchObject({ caseType: "planted", gold: [{ path: "src/clamp.ts", line: 2 }], plantedOn: "c1" });
    expect(control?.plant?.text).toContain("if (!(x > 10)) {");
  });

  it("refuse a head that is not clean", async () => {
    await expect(plantOn(body("d1", "defect"), "deleted-assertion", git)).rejects.toThrow(/not a clean head/);
    await expect(plantOn(body("p1", "planted"), "deleted-assertion", git)).rejects.toThrow(/not a clean head/);
  });
});

const KINDS = ["correctness", "feature", "refactor", "security"];
const pool = (caseType: CaseType, size: number): { id: string; caseType: CaseType; kind: string }[] =>
  Array.from({ length: size }, (_, index) => ({ id: `${caseType}-${index}`, caseType, kind: KINDS[index % KINDS.length] ?? "unknown" }));

describe("stratifiedQueue", () => {
  const queue = stratifiedQueue([...pool("defect", 60), ...pool("planted", 40), ...pool("clean", 60)], "bench-2026-11");
  const typesIn = (blocks: readonly { caseType: CaseType }[]): Record<CaseType, number> =>
    Object.fromEntries(CASE_TYPES.map((type) => [type, blocks.filter((block) => block.caseType === type).length])) as Record<CaseType, number>;

  it("holds every case type in every run of 10 blocks", () => {
    expect(queue).toHaveLength(160);
    for (let start = 0; start < queue.length; start += 10) {
      const counts = typesIn(queue.slice(start, start + 10));
      expect(CASE_TYPES.filter((type) => counts[type] === 0), `blocks ${start}-${start + 9}`).toEqual([]);
    }
  });

  it("puts about 4 real, 2-3 planted and 3-4 clean cases in the first 10 blocks", () => {
    const counts = typesIn(queue.slice(0, 10));
    expect(counts.defect).toBeGreaterThanOrEqual(3);
    expect(counts.defect).toBeLessThanOrEqual(4);
    expect([2, 3]).toContain(counts.planted);
    expect([3, 4]).toContain(counts.clean);
  });

  it("is the same queue for the same seed and a different one for another", () => {
    const cases = pool("defect", 20);
    expect(stratifiedQueue(cases, "s1")).toEqual(stratifiedQueue(cases, "s1"));
    expect(stratifiedQueue(cases, "s1")).not.toEqual(stratifiedQueue(cases, "s2"));
  });
});

describe("interleave", () => {
  it("keeps each group's order and spreads a smaller group evenly", () => {
    expect(interleave([["a1", "a2", "a3", "a4"], ["b1", "b2"]])).toEqual(["a1", "b1", "a2", "a3", "b2", "a4"]);
  });
});

describe("buildReviewSample", () => {
  it("never samples a head it planted on as a clean case, and skips commits the clone lacks", async () => {
    const cleans = ["1", "2", "3", "4"].map((n) => body(`clean-${n}`, "clean"));
    const defects = [body("defect-5", "defect"), body("defect-6", "defect", { repo: "acme/gadgets" })];
    const heads = new Set([...cleans, ...defects].map((item) => item.head).concat(sha("0")));
    heads.delete(sha("6"));
    const git = fakeGit(heads);
    const { queue, manifest } = await buildReviewSample({ bodies: [...cleans, ...defects], gitFor: () => git, seed: "s", counts: { defect: 2, planted: 2, clean: 4 } });
    const plantedOn = queue.flatMap((item) => item.plantedOn ?? []);
    expect(plantedOn).toHaveLength(2);
    expect(queue.filter((item) => item.caseType === "clean" && plantedOn.includes(item.id))).toEqual([]);
    expect(manifest.counts).toEqual({ defect: 1, planted: 2, clean: 2 });
    expect(manifest.skipped).toEqual({ gadgets: { unreachable: 1 } });
    expect(manifest.shortfall).toEqual({ defect: 1, clean: 2 });
  });
});

describe("loadCasesV1", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const v1 = (id: string, tags: string[], ref: string, extra: object = {}) => ({
    schema: "titan.case/v1",
    id,
    input: { repo: "acme/widgets", pr: 3, head: sha("a"), base: sha("b") },
    fixture: { kind: "repo" },
    split: "dev",
    tags: ["review-pr", ...tags],
    provenance: { source: "history", ref },
    ...extra,
  });

  it("joins kinds through the corpus, a control through the clean case it was planted on", () => {
    dir = mkdtempSync(join(tmpdir(), "cases-v1-"));
    mkdirSync(join(dir, "cases"));
    const cases = [
      v1("w-clean", ["clean"], `run1@${sha("a")}`),
      v1("w-defect", ["defect"], `run2@${sha("a")}`, { expected: { verdict: "FIX_FIRST", defects: [{ path: "src/x.ts", description: "d" }] } }),
      v1("w-control", ["control", "toothless-test"], "planted:toothless-test:w-clean", { fixture: { kind: "tree", path: "trees/w-control" }, expected: { defects: [{ path: "src/x.test.ts", line: 4 }] } }),
    ];
    for (const item of cases) writeFileSync(join(dir, "cases", `${item.id}.json`), JSON.stringify(item));
    const corpus = [{ runId: "run1", head: sha("a"), kind: "refactor" }, { runId: "run2", head: sha("a"), kind: null }].map((row) => JSON.stringify(row)).join("\n");
    const loaded = new Map(loadCasesV1(dir, corpus).map((item) => [item.id, item]));
    expect(loaded.get("w-clean")).toMatchObject({ caseType: "clean", kind: "refactor", gold: [] });
    expect(loaded.get("w-defect")).toMatchObject({ caseType: "defect", kind: "unknown", gold: [{ path: "src/x.ts" }] });
    expect(loaded.get("w-control")).toMatchObject({ caseType: "planted", kind: "refactor", plantedOn: "w-clean", tree: join(dir, "trees/w-control"), gold: [{ path: "src/x.test.ts", line: 4 }] });
  });
});
