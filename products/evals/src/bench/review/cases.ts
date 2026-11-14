import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ControlKind } from "../../review-pr/controls.js";
import { hashCanonical, sha256Hex } from "../../hash.js";
import type { BenchCase } from "../runner.js";

export const CASE_TYPES = ["defect", "planted", "clean"] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export interface GoldDefect {
  path: string;
  /** Planted defects only: the 1-based head line the plant rewrote or deleted. */
  line?: number;
}

/** A defect planted at job time into one head file, so the case file carries the mutation and no tree. */
export interface Plant {
  kind: ControlKind;
  path: string;
  line: number;
  text: string;
}

export interface ReviewCaseBody {
  id: string;
  caseType: CaseType;
  kind: string;
  repo: string;
  pr: number;
  head: string;
  base: string;
  split: string;
  gold: GoldDefect[];
  /** An existing control: a directory already holding `head`, `base` and `diff.patch`. */
  tree?: string;
  plant?: Plant;
  /** The clean case a planted one was built on, so its head is never sampled as clean too. */
  plantedOn?: string;
}

export type ReviewCase = ReviewCaseBody & BenchCase & { stratum: { kind: string; caseType: CaseType } };

const CaseV1Schema = z.looseObject({
  schema: z.literal("titan.case/v1"),
  id: z.string().min(1),
  input: z.looseObject({ repo: z.string(), pr: z.number().int(), head: z.string(), base: z.string() }),
  fixture: z.looseObject({ kind: z.string(), path: z.string().optional() }),
  expected: z.looseObject({ defects: z.array(z.looseObject({ path: z.string(), line: z.number().int().optional() })) }).optional(),
  split: z.string(),
  tags: z.array(z.string()),
  provenance: z.looseObject({ ref: z.string() }),
});
type CaseV1 = z.infer<typeof CaseV1Schema>;

const CorpusKindSchema = z.looseObject({ runId: z.string(), head: z.string(), kind: z.string().nullable().optional() });

/** `runId@head` to the PR kind the corpus registered; a null kind reads `unknown`. */
export function corpusKinds(corpusText: string): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const line of corpusText.split("\n")) {
    if (line.trim() === "") continue;
    const row = CorpusKindSchema.parse(JSON.parse(line));
    kinds.set(`${row.runId}@${row.head}`, row.kind ?? "unknown");
  }
  return kinds;
}

const PLANTED_REF = /^planted:[\w-]+:(.+)$/;

const caseTypeOf = (tags: readonly string[]): CaseType | undefined =>
  tags.includes("control") ? "planted" : tags.includes("defect") ? "defect" : tags.includes("clean") ? "clean" : undefined;

/** A control's kind is the kind of the clean case it was planted on, which its provenance names. */
function kindOf(raw: CaseV1, byId: ReadonlyMap<string, CaseV1>, kinds: ReadonlyMap<string, string>): string {
  const planted = PLANTED_REF.exec(raw.provenance.ref);
  const ref = planted ? byId.get(planted[1] ?? "")?.provenance.ref : raw.provenance.ref;
  return (ref !== undefined ? kinds.get(ref) : undefined) ?? "unknown";
}

function bodyOf(raw: CaseV1, dir: string, byId: ReadonlyMap<string, CaseV1>, kinds: ReadonlyMap<string, string>): ReviewCaseBody | undefined {
  const caseType = caseTypeOf(raw.tags);
  if (caseType === undefined) return undefined;
  const { repo, pr, head, base } = raw.input;
  const gold = (raw.expected?.defects ?? []).map((defect) => ({ path: defect.path, ...(defect.line !== undefined && { line: defect.line }) }));
  const tree = raw.fixture.kind === "tree" && raw.fixture.path !== undefined ? join(dir, raw.fixture.path) : undefined;
  const plantedOn = PLANTED_REF.exec(raw.provenance.ref)?.[1];
  return { id: raw.id, caseType, kind: kindOf(raw, byId, kinds), repo, pr, head, base, split: raw.split, gold, ...(tree && { tree }), ...(plantedOn && { plantedOn }) };
}

/** Every `titan.case/v1` file under `<dir>/cases`, as bench bodies, in id order. */
export function loadCasesV1(dir: string, corpusText: string): ReviewCaseBody[] {
  const casesDir = join(dir, "cases");
  const raws = readdirSync(casesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => CaseV1Schema.parse(JSON.parse(readFileSync(join(casesDir, name), "utf8"))));
  const byId = new Map(raws.map((raw) => [raw.id, raw]));
  const kinds = corpusKinds(corpusText);
  return raws.flatMap((raw) => bodyOf(raw, dir, byId, kinds) ?? []);
}

export function benchCaseOf(body: ReviewCaseBody): ReviewCase {
  return { ...body, hash: hashCanonical(body), stratum: { kind: body.kind, caseType: body.caseType } };
}

/** A stable seeded order: a new seed reshuffles, the same seed reproduces. */
export function seededOrder<T extends { id: string }>(items: readonly T[], seed: string, salt: string): T[] {
  const key = (item: T): string => sha256Hex(`${seed}\0${salt}\0${item.id}`);
  return [...items].sort((left, right) => (key(left) < key(right) ? -1 : 1));
}

/**
 * Interleaves groups so every prefix holds each group in near proportion to its size: each step takes from the group
 * furthest behind its share. Each group keeps its own order.
 */
export function interleave<T>(groups: readonly (readonly T[])[]): T[] {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const taken = groups.map(() => 0);
  const out: T[] = [];
  for (let step = 1; step <= total; step++) {
    let best = -1;
    let bestDeficit = -Infinity;
    groups.forEach((group, index) => {
      const deficit = (group.length * step) / total - (taken[index] ?? 0);
      if ((taken[index] ?? 0) < group.length && deficit > bestDeficit) [best, bestDeficit] = [index, deficit];
    });
    const item = groups[best]?.[taken[best] ?? 0];
    if (item !== undefined) out.push(item);
    taken[best] = (taken[best] ?? 0) + 1;
  }
  return out;
}

const groupBy = <T>(items: readonly T[], key: (item: T) => string): T[][] => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.keys()].sort().map((name) => groups.get(name) ?? []);
};

/** Strata are kind × case type: case types interleave by share, and within a type its kinds interleave by share. */
export function stratifiedQueue<T extends { id: string; caseType: CaseType; kind: string }>(cases: readonly T[], seed: string): T[] {
  const byType = CASE_TYPES.map((caseType) => {
    const strata = groupBy(cases.filter((item) => item.caseType === caseType), (item) => item.kind);
    return interleave(strata.map((stratum) => seededOrder(stratum, seed, `${caseType}:${stratum[0]?.kind ?? ""}`)));
  });
  return interleave(byType);
}

/** The queue `bench cases --track r` wrote, one case per line in run order. */
export function loadReviewQueue(dir: string): ReviewCase[] {
  const path = join(dir, "queue.jsonl");
  if (!existsSync(path)) throw new Error(`${path} is missing: build it with \`bench cases --track r\``);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => benchCaseOf(JSON.parse(line) as ReviewCaseBody));
}
