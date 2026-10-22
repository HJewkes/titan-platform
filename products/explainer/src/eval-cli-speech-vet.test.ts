import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { voiceCheck } from "./lint-voice.js";
import type { SentenceVet } from "./speech-vet-gate.js";
import { tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const RULES = "schema: rules/v1\nrules:\n  - { id: Q-D2, rule: one job per beat, fields: [beats.visual.job], owner_support: none, l0: { severity: error, status: pending, owner: SQ5 } }\n";
const words = (n: number) => `${Array.from({ length: n }, () => "scan").join(" ")}.`;
const THIRTY = words(30);

let dir: string;
let stderr: string[];

const scriptFile = (spoken: string): string => {
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify(tour(withBeat("w2", { spoken }))));
  return path;
};

const l0 = (spoken: string, speechVet: () => Promise<SentenceVet>, ...extra: string[]) =>
  runEvalCli(
    ["eval", "l0", scriptFile(spoken), "--config", "tour-short/script-v1-01", "--rules", join(dir, "rules.yaml"), "--bench", join(dir, "bench"), ...extra],
    { checks: [voiceCheck], speechVet },
  );

function q9Pass(): string | undefined {
  const [header = "", ...rows] = readFileSync(join(dir, "bench/evals/structure.tsv"), "utf8").trimEnd().split("\n");
  const columns = header.split("\t");
  const row = rows.map((line) => line.split("\t")).find((cells) => cells[columns.indexOf("check_id")] === "Q-V9");
  return row?.[columns.indexOf("pass")];
}

const vetting = (status: string) => vi.fn<SentenceVet>(() => Promise.resolve({ status }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-speech-vet-"));
  writeFileSync(join(dir, "rules.yaml"), RULES);
  stderr = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((line: string) => void stderr.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval l0 --speech-vet", () => {
  it("vets only the sentence over twenty-five words and passes Q-V9 when speech-vet accepts it", async () => {
    const vet = vetting("accepted");

    await l0(`${THIRTY} ${words(20)}`, () => Promise.resolve(vet), "--speech-vet");

    expect(vet.mock.calls).toEqual([[THIRTY]]);
    expect(q9Pass()).toBe("true");
    expect(stderr).toContain("speech-vet: vetted 1 sentence(s) of 26-32 words: 1 accepted");
  });

  it("fails Q-V9 when speech-vet asks for a rewrite", async () => {
    await l0(THIRTY, () => Promise.resolve(vetting("needs-rewrite")), "--speech-vet");

    expect(q9Pass()).toBe("false");
  });

  it("fails Q-V9 when the vet throws, rather than failing open", async () => {
    const vet = vi.fn<SentenceVet>(() => Promise.reject(new Error("kokoro timed out")));

    await l0(THIRTY, () => Promise.resolve(vet), "--speech-vet");

    expect(q9Pass()).toBe("false");
    expect(stderr).toContain("speech-vet: vetted 1 sentence(s) of 26-32 words: 1 error");
  });

  it("keeps the twenty-five word cap when the vetter cannot be built, and says so", async () => {
    await l0(THIRTY, () => Promise.reject(new Error("no transformers peer")), "--speech-vet");

    expect(q9Pass()).toBe("false");
    expect(stderr).toContain("speech-vet: unavailable (no transformers peer); 1 sentence(s) of 26-32 words keep the 25-word Q-V9 cap");
  });

  it("keeps the twenty-five word cap without the flag and never builds a vetter", async () => {
    const factory = vi.fn(() => Promise.resolve(vetting("accepted")));

    await l0(THIRTY, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(q9Pass()).toBe("false");
    expect(stderr).toContain("speech-vet: off; 1 sentence(s) of 26-32 words keep the 25-word Q-V9 cap (pass --speech-vet to vet them)");
  });

  it("loads no speech models for a script with nothing to vet", async () => {
    const factory = vi.fn(() => Promise.resolve(vetting("accepted")));

    await l0(`${words(25)} ${words(33)}`, factory, "--speech-vet");

    expect(factory).not.toHaveBeenCalled();
    expect(q9Pass()).toBe("false");
  });
});
