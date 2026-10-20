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

const toolErrors = (sums: Map<string, string>, run: ToolRun): string[] => [
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
