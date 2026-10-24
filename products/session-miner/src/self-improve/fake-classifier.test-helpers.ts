import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import type { RunnerFor } from "./run.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/** Invented follow-up rows keyed by item id; nothing here is real session text. */
const ROWS: Record<string, Record<string, unknown>> = {
  F1: { item: "F1", cls: "re-review-new-head", mechanical: true, could_be_owned_by: "shepherd", theme: "tide check" },
  F2: { item: "F2", cls: "verdict-relay", mechanical: true, could_be_owned_by: "agent-chat", theme: "verdict relay" },
  F3: { item: "F3", cls: "status-ping", mechanical: true, could_be_owned_by: "none", theme: "status ping" },
};

export type Answer = (input: StepRunInput, call: number) => StepRunOutcome | Promise<StepRunOutcome>;

export interface FakeClassifier {
  runnerFor: RunnerFor;
  options: AgentRunnerOptions[];
  /** The item ids of each call's chunk, in call order. */
  chunks: string[][];
}

/** The item ids in the chunk half of a prompt. */
export function chunkIds(prompt: string): string[] {
  return [...(prompt.split("INPUT FOLLOWS.")[1] ?? "").matchAll(/\bF\d+\b/g)].map((match) => match[0]);
}

export function rowsAnswer(costUsd = 0.05): Answer {
  return (input) => {
    const rows = chunkIds(input.prompt).map((id) => ROWS[id] ?? { item: id, cls: "info-fyi", mechanical: false, could_be_owned_by: "none", theme: "other" });
    return { ok: true, output: JSON.stringify({ rows }), usage: { costUsd } };
  };
}

/** Kills the run as call `call` starts: the call never answers, as a process killed mid-call would not. */
export function crashAt(call: number, crash: AbortController, otherwise: Answer = rowsAnswer()): Answer {
  return (input, n) => {
    if (n !== call) return otherwise(input, n);
    setTimeout(() => crash.abort(), 0);
    return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({ ok: false, error: "killed", retryable: false })));
  };
}

export function fakeClassifier(answer: Answer = rowsAnswer()): FakeClassifier {
  const fake: FakeClassifier = { options: [], chunks: [], runnerFor: () => ({ run: async () => ({ ok: false, error: "unreachable", retryable: false }) }) };
  fake.runnerFor = (options) => {
    fake.options.push(options);
    return { run: async (input) => answer(input, fake.chunks.push(chunkIds(input.prompt))) };
  };
  return fake;
}

export interface Workspace {
  chunks: string;
  prompts: string;
  out: string;
  state: string;
  writeChunk: (name: string, text: string) => void;
  cleanup: () => void;
}

/** A chunk dir holding the committed fixtures, a prompt for every family, and empty out and state dirs. */
export function workspace(): Workspace {
  const root = mkdtempSync(path.join(os.tmpdir(), "titan-miner-self-improve-"));
  const dirs = { chunks: path.join(root, "chunks"), prompts: path.join(root, "prompts"), out: path.join(root, "out"), state: path.join(root, "state") };
  cpSync(path.join(FIXTURES, "chunks"), dirs.chunks, { recursive: true });
  mkdirSync(dirs.prompts);
  for (const id of ["c1_owner", "c2_followups", "c3_handoffs", "c4_logs", "c5_concerns"]) writeFileSync(path.join(dirs.prompts, `${id}.md`), `Classify each ${id} item as one row.\n`);
  return {
    ...dirs,
    writeChunk: (name, text) => writeFileSync(path.join(dirs.chunks, `${name}.txt`), text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
