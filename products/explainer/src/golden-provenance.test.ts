import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GOLDENS = new URL("../fixtures/spike/goldens/", import.meta.url);

interface ToolRun {
  tool: string;
  sha256: string;
  outputSha256: string;
  dataTool?: { tool: string; sha256: string };
}

interface ScriptProvenance {
  frozenScript: { path: string; sha256: string };
  goldens: Record<string, ToolRun>;
}

interface Provenance {
  bundle: { path: string; sha256: string };
  scripts: Record<string, ScriptProvenance>;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const readGolden = (path: string): Buffer => readFileSync(new URL(path, GOLDENS));
const loadProvenance = (): Provenance => JSON.parse(readGolden("provenance.json").toString("utf8")) as Provenance;

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
