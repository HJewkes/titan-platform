import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { indexCorpus } from "../index-corpus.js";
import { archiveLayout } from "../layout.js";
import { writeCorpus, type SyntheticFile } from "../synthetic-corpus.test-helpers.js";
import type { QuerySpec } from "../types.js";
import type { RunnerFor } from "./routes.js";

/** Invented league and silverware; nothing here is real corpus text. */
export const SPEC: QuerySpec = {
  entity: "trophy won by the Gull Rovers",
  rowFields: ["entity", "subject", "period", "detail"],
  termGroups: [["cup"], ["won"]],
  phrases: [],
  seedLexicon: [],
  mode: "broad",
  inclusion: ["the Gull Rovers win the trophy on the page"],
  exclusion: ["a final the Gull Rovers lose"],
  canaries: [
    { text: "Marsh Town won the Reed Cup after a long replay.", expect: "match" },
    { text: "Marsh Town lost the Reed Cup final in the rain.", expect: "no-match" },
  ],
};

const chapter = (book: number, n: number, line: string): SyntheticFile => ({
  relPath: `gull-rovers/book_0${book}/chapter_0${n}.txt`,
  title: `${book}.${n} - Matchday`,
  published: `2026-0${book}-0${n}`,
  body: ["Fog over the harbour.", line, "Rain all evening."].join("\n\n"),
});

/** Five winning chapters: three in book 1, two in book 2. Each is one passage. */
export const WINS: SyntheticFile[] = [
  chapter(1, 1, "The Gull Rovers won the Pebble Cup."),
  chapter(1, 2, "The Gull Rovers won the Shingle Cup."),
  chapter(1, 3, "The Gull Rovers won the Driftwood Cup."),
  chapter(2, 1, "The Gull Rovers won the Lantern Cup."),
  chapter(2, 2, "The Gull Rovers won the Anchor Cup."),
];

/** Chapters reachable only through names a judge reports, never through the spec's own terms. */
export const CHAIN: SyntheticFile[] = [
  chapter(3, 1, "The Gull Rovers lifted the Kestrel Shield."),
  chapter(3, 2, "The Gull Rovers lifted the Osprey Plate."),
  chapter(3, 3, "The Gull Rovers lifted the Heron Bowl."),
];

export interface Fixture {
  root: string;
  index: string;
  dataDir: string;
  cleanup: () => void;
}

export function fixture(files: SyntheticFile[]): Fixture {
  const corpus = writeCorpus(files);
  const work = mkdtempSync(path.join(tmpdir(), "corpus-query-run-"));
  const index = path.join(work, "index.sqlite3");
  const db = openDatabase(index);
  indexCorpus(db, corpus.root, archiveLayout);
  db.close();
  return { root: corpus.root, index, dataDir: path.join(work, "data"), cleanup: () => (corpus.cleanup(), rmSync(work, { recursive: true, force: true })) };
}

export interface Call {
  stage: string;
  stepId: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Display refs of the passages shown, canaries excluded. */
  refs: string[];
  startedAt: number;
  endedAt?: number;
}

export type Behave = (call: Call, input: StepRunInput) => Promise<StepRunOutcome> | StepRunOutcome | undefined;

interface Shown {
  id: string;
  ref: string;
  text: string;
}

const PASSAGE = /^=== PASSAGE (\S+) \((.*)\) ===$/gm;

function shownPassages(prompt: string): Shown[] {
  const heads = [...prompt.matchAll(PASSAGE)];
  return heads.map((head, i) => ({ id: head[1]!, ref: head[2]!, text: prompt.slice(head.index + head[0].length + 1, heads[i + 1]?.index).trim() }));
}

const winningLine = (text: string): string | undefined => text.split("\n\n").find((line) => /\b(won|lifted)\b/.test(line));

const ok = (output: unknown): StepRunOutcome => ({ ok: true, output: JSON.stringify(output), usage: { costUsd: 0.01 } });

function verdict(stage: string, prompt: string, names: Record<string, string[]>): StepRunOutcome {
  const passages = shownPassages(prompt);
  const wins = passages.flatMap((p) => {
    const quote = winningLine(p.text);
    return quote ? [{ p, quote, trophy: /the (\w+ \w+)\./.exec(quote)?.[1] ?? "" }] : [];
  });
  const judged = passages.map((p) => p.id);
  if (stage === "screen") {
    return ok({ judged, candidates: wins.map(({ p, quote, trophy }) => ({ id: p.id, quote, entity: trophy, subject: "Gull Rovers", event: "won", names: names[trophy] ?? [] })) });
  }
  return ok({ judged, rows: wins.map(({ p, quote, trophy }) => ({ id: p.id, entity: trophy, subject: "Gull Rovers", period: p.ref, detail: "final", role: "manager", quote, event: "won", confidence: "sure", reason: "won on the page" })) });
}

/**
 * Stands in for every `claude -p` call. By default a judge flags each passage holding "won" or "lifted" and reports
 * the names `names` maps that trophy to; `behave` overrides any call.
 */
export function fakeJudges(options: { names?: Record<string, string[]>; behave?: Behave; delayMs?: number } = {}): { runnerFor: RunnerFor; calls: Call[] } {
  const calls: Call[] = [];
  const runnerFor: RunnerFor = (runner: AgentRunnerOptions) => ({
    async run(input) {
      const call: Call = {
        stage: input.stepId.split(":")[0]!,
        stepId: input.stepId,
        model: input.model ?? runner.defaults!.model!,
        systemPrompt: runner.defaults!.systemPrompt!,
        prompt: input.prompt,
        refs: shownPassages(input.prompt).filter((p) => p.ref !== "CANARY").map((p) => p.ref),
        startedAt: performance.now(),
      };
      calls.push(call);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const outcome = (await options.behave?.(call, input)) ?? (call.stage === "compile" ? ok(SPEC) : verdict(call.stage, input.prompt, options.names ?? {}));
      call.endedAt = performance.now();
      return outcome;
    },
  });
  return { runnerFor, calls };
}
