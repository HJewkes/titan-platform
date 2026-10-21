import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { runRewriteCli, type RewriteCliDeps } from "./rewrite-cli.js";
import { choppy, compliant, fakeRewriter, type Rewriter } from "./rewrite-fixtures.test-helpers.js";
import type { RewriteReport } from "./rewrite-pass.js";
import { ScriptSchema } from "./script-schema.js";
import { pipelineScript } from "./spike-fixtures.test-helpers.js";

let dir: string;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-rewrite-"));
});

async function run(script: string, extra: string[] = [], deps: RewriteCliDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const argv = ["rewrite", script, "--judge", write("judge.json", sonnet), "--out", join(dir, "out.json"), ...extra];
  const code = await runRewriteCli(argv, { harness: () => fakeRewriter().harness, ...deps, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(""), err: err.join("") };
}

const failing = fakeRewriter(compliant, () => "model_error: offline");

// Joins h1 into one 30-word sentence: past the plain cap, inside the vetted one.
const LONG_H1 =
  "When a courier asks for a label, the desk refuses ghost labels, so it looks for the parcel row and waits for the ledger before it prints anything at all.";
const longH1: Rewriter = (id, prompt) => (id === "h1" ? { id, spoken: LONG_H1, labels_added: [] } : compliant(id, prompt));

function fakeVet(status: string) {
  const vetted: string[] = [];
  const speechVet = async () => async (sentence: string) => {
    vetted.push(sentence);
    return { status };
  };
  return { speechVet, vetted };
}

describe("explainer rewrite", () => {
  it("writes the rewritten script and its report, prints the row deltas and exits 0 when every target row passes", async () => {
    const { code, out } = await run(write("in.json", choppy()), ["--report", join(dir, "report.json")]);

    expect(code).toBe(0);
    expect(ScriptSchema.parse(readJson("out.json")).beats.find((beat) => beat.id === "h2")!.visual.labels).toEqual(["3 sent back"]);
    expect((readJson("report.json") as RewriteReport).rounds[0]).toMatchObject({ round: 1, kept: true });
    const line = JSON.parse(out) as { pass: boolean; rows: { pass: boolean }[]; calls: number; usd: number };
    expect(line).toMatchObject({ pass: true, calls: 4, failed_calls: 0, out: join(dir, "out.json") });
    expect(line.rows).toHaveLength(5);
    expect(line.usd).toBeCloseTo(0.04);
  });

  it("still writes the script but exits 1 when target rows stay red", async () => {
    const { code, out } = await run(write("in.json", choppy()), [], { harness: () => failing.harness });

    expect(code).toBe(1);
    expect(ScriptSchema.parse(readJson("out.json")).beats).toHaveLength(12);
    expect(JSON.parse(out)).toMatchObject({ pass: false, failed_calls: 8 });
  });

  it("exits 2 and writes nothing on a judge config that does not parse", async () => {
    const judge = write("bad-judge.json", { provider: "nope", model: "x" });
    const out = join(dir, "out.json");

    const code = await runRewriteCli(["rewrite", write("in.json", choppy()), "--judge", judge, "--out", out], { err: () => {} });

    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("exits 2 on an input that is not JSON, and on an out-of-range round count", async () => {
    expect((await run(write("in.json", "{ not json"))).code).toBe(2);
    expect((await run(write("in.json", choppy()), ["--rounds", "3"])).code).toBe(2);
    expect(existsSync(join(dir, "out.json"))).toBe(false);
  });

  it("migrates a spike script with --format spike, and refuses it as script/v1 without the flag", async () => {
    const spike = write("spike.json", pipelineScript());

    const migrated = await run(spike, ["--format", "spike"], { harness: () => failing.harness });
    const unmigrated = await run(spike, [], { harness: () => failing.harness });

    expect(migrated.code).toBe(1);
    expect(ScriptSchema.safeParse(readJson("out.json")).success).toBe(true);
    expect(unmigrated.code).toBe(2);
  });
});

describe("explainer rewrite --speech-vet", () => {
  it("vets a rewritten sentence of 26 to 32 words and keeps it when speech-vet accepts it", async () => {
    const vet = fakeVet("accepted");

    await run(write("in.json", choppy()), ["--speech-vet", "--rounds", "1", "--report", join(dir, "report.json")], {
      harness: () => fakeRewriter(longH1).harness,
      speechVet: vet.speechVet,
    });

    expect(vet.vetted).toContain(LONG_H1);
    expect((readJson("report.json") as RewriteReport).rounds[0]!.rewritten).toContain("h1");
  });

  it("rejects that sentence when speech-vet does not accept it", async () => {
    const vet = fakeVet("rejected");

    const { err } = await run(write("in.json", choppy()), ["--speech-vet", "--rounds", "1", "--report", join(dir, "report.json")], {
      harness: () => fakeRewriter(longH1).harness,
      speechVet: vet.speechVet,
    });

    const rejected = (readJson("report.json") as RewriteReport).rounds[0]!.rejected.find((beat) => beat.beat === "h1");
    expect(rejected?.rejections.map((r) => r.rule)).toContain("sentence-cap");
    expect(err).toContain("speech-vet: vetted 1 sentence(s) of 26-32 words: 1 rejected");
  });

  it("vets nothing without the flag, so the long sentence keeps the plain cap", async () => {
    const vet = fakeVet("accepted");

    await run(write("in.json", choppy()), ["--rounds", "1", "--report", join(dir, "report.json")], {
      harness: () => fakeRewriter(longH1).harness,
      speechVet: vet.speechVet,
    });

    expect(vet.vetted).toEqual([]);
    expect((readJson("report.json") as RewriteReport).rounds[0]!.rewritten).not.toContain("h1");
  });

  it("runs without verdicts and says so when no vetter can be built", async () => {
    const { code, err } = await run(write("in.json", choppy()), ["--speech-vet"], {
      speechVet: () => Promise.reject(new Error("no Kokoro model")),
    });

    expect(code).toBe(0);
    expect(err).toContain("speech-vet: unavailable (no Kokoro model)");
  });
});
