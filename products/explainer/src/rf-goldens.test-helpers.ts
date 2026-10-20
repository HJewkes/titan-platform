import { readFileSync } from "node:fs";
import { z } from "zod";

export const GOLDENS = new URL("../fixtures/spike/goldens/", import.meta.url);

export const readGolden = (path: string): Buffer => readFileSync(new URL(path, GOLDENS));

export const Pinned = z.object({ tool: z.string(), sha256: z.string() });

export const FAMILIES = [
  "bands",
  "banned phrases",
  "numbers",
  "outro",
  "rules 3/5",
  "chip rows",
  "map/pin/edge-label",
  "recipe/contested/edge-table/origin",
  "budgets",
] as const;

const SeedsSchema = z.object({
  seeds: z.record(
    z.string(),
    z.object({
      base: z.string(),
      family: z.enum(FAMILIES),
      check: z.string(),
      seed: z.string(),
      edits: z.array(z.object({ path: z.string(), value: z.unknown() })).min(1),
    }),
  ),
});
const SeededProvenanceSchema = z.object({
  bases: z.record(z.string(), Pinned.extend({ fixture: z.string(), fixtureSha256: z.string(), dataTool: Pinned })),
  variants: z.record(
    z.string(),
    z.object({ base: z.string(), scriptSha256: z.string(), exitCode: z.number(), outputSha256: z.string() }),
  ),
});
const LintSchema = z.object({
  exitCode: z.number(),
  issues: z.array(z.object({ beat: z.string().nullable(), check: z.string(), severity: z.string(), message: z.string() })),
});
export type Seed = z.infer<typeof SeedsSchema>["seeds"][string];
export type SeededProvenance = z.infer<typeof SeededProvenanceSchema>;
export type Lint = z.infer<typeof LintSchema>;

const readJson = (path: string): unknown => JSON.parse(readGolden(path).toString("utf8"));
export const loadSeeds = () => SeedsSchema.parse(readJson("seeded/seeds.json")).seeds;
export const loadSeededProvenance = () => SeededProvenanceSchema.parse(readJson("seeded/provenance.json"));
export const loadLint = (variant: string): Lint => LintSchema.parse(readJson(`seeded/${variant}/lint.json`));
export const loadFrozenLint = (script: string): Lint => LintSchema.parse(readJson(`${script}/lint.json`));
export const fixtureBytes = (fixture: string): Buffer => readFileSync(new URL(`../${fixture}`, GOLDENS));

/** A JSON object or array; arrays index by their string keys too. */
const isContainer = (node: unknown): node is Record<string, unknown> => typeof node === "object" && node !== null;

const child = (node: unknown, key: string): unknown => {
  if (!isContainer(node)) throw new Error(`seed path runs through a non-container at ${key}`);
  return node[key];
};

/** Sets each JSON pointer to its value (an array index one past the end appends); throws on a no-op edit. */
export const applyEdits = (doc: unknown, edits: Seed["edits"]): unknown => {
  for (const { path, value } of edits) {
    const keys = path.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    const last = keys.pop() ?? "";
    const parent = keys.reduce(child, doc);
    if (!isContainer(parent)) throw new Error(`edit ${path} has no parent container`);
    if (JSON.stringify(parent[last]) === JSON.stringify(value)) throw new Error(`edit ${path} changes nothing`);
    parent[last] = value;
  }
  return doc;
};

