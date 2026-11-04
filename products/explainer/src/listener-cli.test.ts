import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { ask, fakeListener, quiet } from "./listener-fakes.test-helpers.js";
import { ListenerResultSchema } from "./listener-questions.js";

const spikeBeat = (id: string, chapter: string, spoken: string) => ({ id, chapter, function: "EXPLAIN", plannedS: 12, spoken, visual: { titles: [] } });
/** An invented parcel desk in two chapters. */
const script = {
  id: "synthetic-listener",
  beats: [
    spikeBeat("c1-1", "ch1", "Four checks come first: weigh, scan and label. Then seal."),
    spikeBeat("c2-1", "ch2", "Every scan lands in the ledger overnight."),
  ],
};

let dir: string;
let lines: string[];
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-listener-"));
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const listener = fakeListener((sentences) => ({
  ...quiet(),
  questions: [...sentences.keys()].map((id) => ask(id, `What about ${id}?`, id === "S1" && sentences.size === 2 ? "checks" : null)),
  lists: sentences.size === 2 ? [{ items: ["weigh", "scan", "label", "seal"], sentences: ["S1", "S2"] }] : [],
}));
const run = (...flags: string[]) =>
  runEvalCli(["eval", "listener", write("script.json", script), "--judge", write("judge.json", { provider: "claude-print", model: "sonnet" }), ...flags], { harness: () => listener.harness });

describe("explainer eval listener", () => {
  it("prints per-chapter counts, density and flags, and exits 0 with no threshold", async () => {
    const code = await run();

    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      questions: 3, sentences: 3, density: 1, pass: true, judge: "claude-print:sonnet",
      chapters: {
        ch1: { questions: 2, sentences: 2, per_sentence: [1, 1], list_spread: 1, terms_before_setup: ["checks"], fragments: ["S2"] },
        ch2: { questions: 1, sentences: 1, per_sentence: [1], list_spread: 0 },
      },
    });
  });

  it("writes every question with its sentence to --out", async () => {
    const out = join(dir, "result.json");

    await run("--out", out);

    const result = ListenerResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(result.chapters[0]!.asked.map((q) => q.sentence)).toEqual(["S1", "S2"]);
  });

  it("exits 1 when a chapter is above --threshold, and 2 on a bad threshold", async () => {
    expect(await run("--threshold", "0.5")).toBe(1);
    expect(await run("--threshold", "-1")).toBe(2);
  });
});
