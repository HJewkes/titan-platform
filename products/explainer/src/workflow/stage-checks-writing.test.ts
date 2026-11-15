import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { l0Check } from "./run-fakes.test-helpers.js";
import { sha256 } from "./artifacts.js";
import { failedGates, runStageChecks, type CheckInput } from "./stage-checks.js";

const FixtureSchema = z.object({ beats: z.array(z.object({ spoken: z.string() })) });
const CLEAN_BEATS = FixtureSchema.parse(JSON.parse(readFileSync(new URL("../../fixtures/writing-check/clean.script.json", import.meta.url), "utf8"))).beats;
const SHORT_LINE = "The kettle sits on the stove all day.";

function input(texts: Record<string, string>): CheckInput {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const artifacts = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  return { artifacts, store: { readText: (sha) => bySha.get(sha)! }, l0Checks: [l0Check(true)] };
}

/** A valid script whose beat i speaks `spoken(i)`; the writing check reads only the narration. */
function scriptSpeaking(spoken: (i: number) => string): string {
  const script = choppy();
  script.beats.forEach((beat, i) => { beat.spoken = spoken(i); });
  return JSON.stringify(script);
}

/** The clean fixture's narration spread over the 12 beats: the first four beats also take its last four. */
const cleanScript = (): string =>
  scriptSpeaking((i) => [CLEAN_BEATS[i]!.spoken, ...(i < CLEAN_BEATS.length - 12 ? [CLEAN_BEATS[12 + i]!.spoken] : [])].join(" "));

/** 25 sentences of eight words make 200 words, past the register floor. */
const shortRegisterScript = (): string => scriptSpeaking((i) => Array.from({ length: i < 1 ? 14 : 1 }, () => SHORT_LINE).join(" "));

const writing = (script: string) => {
  const run = runStageChecks("rewrite", input({ draft: script, script, "rewrite-report": JSON.stringify({ after: [] }) }));
  return { run, check: run.checks.find((check) => check.name === "writing") };
};

describe("rewrite stage writing check", () => {
  it("reports a short-register script as failing, names the row, and fails no gate", () => {
    const { run, check } = writing(shortRegisterScript());

    expect(check).toMatchObject({ gate: false, pass: false });
    expect(check?.detail).toContain("writing:short-register");
    expect(failedGates(run.checks).map((gate) => gate.name)).not.toContain("writing");
  });

  it("reports a clean script as passing, with its word count and bucket", () => {
    const { check } = writing(cleanScript());

    expect(check).toMatchObject({ gate: false, pass: true });
    expect(check?.detail).toMatch(/\d+ words; bucket \S+; 0 gate fails; \d+ warnings; failing rows: none/);
  });
});
