import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const GOLDENS = new URL("../fixtures/spike/goldens/", import.meta.url);

const Pinned = z.object({ tool: z.string(), sha256: z.string() });
const ToolRunSchema = Pinned.extend({ outputSha256: z.string(), dataTool: Pinned.optional() });
const ProvenanceSchema = z.object({
  bundle: z.object({ path: z.string(), sha256: z.string() }),
  scripts: z.record(
    z.string(),
    z.object({
      frozenScript: z.object({ path: z.string(), sha256: z.string() }),
      goldens: z.record(z.string(), ToolRunSchema),
    }),
  ),
});
type ToolRun = z.infer<typeof ToolRunSchema>;
type Provenance = z.infer<typeof ProvenanceSchema>;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const readGolden = (path: string): Buffer => readFileSync(new URL(path, GOLDENS));
const loadProvenance = (): Provenance => ProvenanceSchema.parse(JSON.parse(readGolden("provenance.json").toString("utf8")));

const loadSums = (): Map<string, string> =>
  new Map(
    readGolden("SHA256SUMS")
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, path] = line.split("  ");
        return [path ?? "", digest ?? ""];
      }),
  );

const mismatch = (sums: Map<string, string>, path: string, digest: string): string[] =>
  sums.get(path) === digest ? [] : [`${path}: recorded ${digest}, A1 SHA256SUMS has ${sums.get(path) ?? "no line"}`];

const toolErrors = (sums: Map<string, string>, run: Omit<ToolRun, "outputSha256">): string[] => [
  ...mismatch(sums, run.tool, run.sha256),
  ...(run.dataTool ? mismatch(sums, run.dataTool.tool, run.dataTool.sha256) : []),
];

/** Every way a golden can drift from the A1 snapshot: a tool, its data module, the frozen script or the bundle. */
const provenanceErrors = (provenance: Provenance, sums: Map<string, string>): string[] => [
  ...mismatch(sums, provenance.bundle.path, provenance.bundle.sha256),
  ...Object.values(provenance.scripts).flatMap((script) => [
    ...mismatch(sums, script.frozenScript.path, script.frozenScript.sha256),
    ...Object.values(script.goldens).flatMap((run) => toolErrors(sums, run)),
  ]),
];

describe("A2 goldens provenance", () => {
  it("records, for every golden, tool sha256s that match the A1 snapshot", () => {
    expect(provenanceErrors(loadProvenance(), loadSums())).toEqual([]);
  });

  it("fails when one golden's recorded tool sha256 differs from the A1 snapshot", () => {
    const provenance = loadProvenance();
    const run = provenance.scripts["review-addendum-v5"]?.goldens["make_sample.full.json"];
    if (!run) throw new Error("addendum make_sample golden missing from provenance.json");
    run.sha256 = run.sha256.replace(/^./, (c) => (c === "0" ? "1" : "0"));

    expect(provenanceErrors(provenance, loadSums())).toEqual([
      expect.stringContaining("rf-snapshot/review-addendum-v5/tools/make_sample.py: recorded"),
    ]);
  });

  it.each(["redesign-explainer-v4", "review-addendum-v5"])("lists exactly the golden files of %s, unedited", (name) => {
    const goldens = loadProvenance().scripts[name]?.goldens ?? {};
    const files = readdirSync(new URL(`${name}/`, GOLDENS)).sort();
    const recorded = Object.entries(goldens).map(([file, run]) => [file, run.outputSha256]);

    expect(Object.keys(goldens).sort()).toEqual(files);
    expect(recorded).toEqual(recorded.map(([file]) => [file, sha256(readGolden(`${name}/${file ?? ""}`))]));
  });

  it("freezes the addendum fixture script byte-equal to the script the tools ran on", () => {
    const fixture = readFileSync(new URL("../review-addendum-v5/script.json", GOLDENS));

    expect(sha256(fixture)).toBe(loadProvenance().scripts["review-addendum-v5"]?.frozenScript.sha256);
  });
});

const FAMILIES = [
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
type Seed = z.infer<typeof SeedsSchema>["seeds"][string];
type SeededProvenance = z.infer<typeof SeededProvenanceSchema>;
type Lint = z.infer<typeof LintSchema>;

const readJson = (path: string): unknown => JSON.parse(readGolden(path).toString("utf8"));
const loadSeeds = () => SeedsSchema.parse(readJson("seeded/seeds.json")).seeds;
const loadSeededProvenance = () => SeededProvenanceSchema.parse(readJson("seeded/provenance.json"));
const loadLint = (variant: string): Lint => LintSchema.parse(readJson(`seeded/${variant}/lint.json`));
const fixtureBytes = (fixture: string): Buffer => readFileSync(new URL(`../${fixture}`, GOLDENS));

/** A JSON object or array; arrays index by their string keys too. */
const isContainer = (node: unknown): node is Record<string, unknown> => typeof node === "object" && node !== null;

const child = (node: unknown, key: string): unknown => {
  if (!isContainer(node)) throw new Error(`seed path runs through a non-container at ${key}`);
  return node[key];
};

/** Sets each JSON pointer to its value (an array index one past the end appends); throws on a no-op edit. */
const applyEdits = (doc: unknown, edits: Seed["edits"]): unknown => {
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

/** The bytes the archived lint read: the base fixture with the seed applied, serialized as the fixtures are. */
const seededScript = (seed: Seed, provenance: SeededProvenance): Buffer => {
  const fixture = provenance.bases[seed.base]?.fixture ?? "";
  const doc = applyEdits(JSON.parse(fixtureBytes(fixture).toString("utf8")), seed.edits);
  return Buffer.from(`${JSON.stringify(doc, null, 1)}\n`);
};

/** Every way a seeded golden can stop matching its seed: the mutated script, the lint output, or the seeded family. */
const variantErrors = (variant: string, seed: Seed, lint: Lint, provenance: SeededProvenance): string[] => {
  const run = provenance.variants[variant];
  if (!run) return [`${variant}: no provenance entry`];
  return [
    ...(run.base === seed.base ? [] : [`${variant}: provenance base ${run.base}, seed base ${seed.base}`]),
    ...(sha256(seededScript(seed, provenance)) === run.scriptSha256 ? [] : [`${variant}: base fixture + seed is not the script the lint ran on`]),
    ...(sha256(readGolden(`seeded/${variant}/lint.json`)) === run.outputSha256 ? [] : [`${variant}: lint.json edited after capture`]),
    ...(lint.exitCode === 1 && run.exitCode === 1 ? [] : [`${variant}: lint exit code ${lint.exitCode}, expected 1`]),
    ...(lint.issues.length > 0 ? [] : [`${variant}: empty issue set`]),
    ...(lint.issues.some((issue) => issue.check === seed.check) ? [] : [`${variant}: no ${seed.check} issue for family ${seed.family}`]),
  ];
};

describe("A2b seeded true-positive lint goldens", () => {
  it("pins each base to its unedited fixture and to tool sha256s in the A1 snapshot", () => {
    const sums = loadSums();
    const errors = Object.entries(loadSeededProvenance().bases).flatMap(([name, base]) => [
      ...(sha256(fixtureBytes(base.fixture)) === base.fixtureSha256 ? [] : [`${name}: fixture ${base.fixture} changed since capture`]),
      ...toolErrors(sums, base),
    ]);

    expect(errors).toEqual([]);
  });

  it("captures one lint.json per seed, and nothing else", () => {
    const seeds = Object.keys(loadSeeds()).sort();
    const dirs = readdirSync(new URL("seeded/", GOLDENS), { withFileTypes: true }).filter((entry) => entry.isDirectory());

    expect(dirs.map((dir) => dir.name).sort()).toEqual(seeds);
    expect(dirs.map((dir) => readdirSync(new URL(`seeded/${dir.name}/`, GOLDENS)))).toEqual(dirs.map(() => ["lint.json"]));
    expect(Object.keys(loadSeededProvenance().variants).sort()).toEqual(seeds);
  });

  it("seeds every RF lint family", () => {
    const families = new Set(Object.values(loadSeeds()).map((seed) => seed.family));

    expect([...families].sort()).toEqual([...FAMILIES].sort());
  });

  it("records, for every seed, a non-empty issue set holding the check its seed targets", () => {
    const provenance = loadSeededProvenance();
    const errors = Object.entries(loadSeeds()).flatMap(([variant, seed]) => variantErrors(variant, seed, loadLint(variant), provenance));

    expect(errors).toEqual([]);
  });

  it("fails when one variant's issue set is emptied", () => {
    const seed = loadSeeds()["v4-banned-simply"];
    if (!seed) throw new Error("v4-banned-simply seed missing from seeds.json");
    const lint = { ...loadLint("v4-banned-simply"), issues: [] };

    expect(variantErrors("v4-banned-simply", seed, lint, loadSeededProvenance())).toEqual([
      "v4-banned-simply: empty issue set",
      "v4-banned-simply: no Q-V1/V4/V7 issue for family banned phrases",
    ]);
  });

  it("fails when a seed's edit no longer yields the script the lint ran on", () => {
    const seed = loadSeeds()["review-addendum-v5-rule5"];
    if (!seed) throw new Error("review-addendum-v5-rule5 seed missing from seeds.json");
    const edited = { ...seed, edits: [{ ...seed.edits[0], path: "/beats/20/visual/cues/3", value: seed.edits[0]?.value }] };

    expect(variantErrors("review-addendum-v5-rule5", edited, loadLint("review-addendum-v5-rule5"), loadSeededProvenance())).toEqual([
      "review-addendum-v5-rule5: base fixture + seed is not the script the lint ran on",
    ]);
  });
});
