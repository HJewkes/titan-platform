import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@titan-design/registry";
import { answerRecCli, roundsAnswerRecArgs } from "./cli-rounds-answer-rec.js";
import { resolveConfig, type ConsoleConfig } from "./config.js";
import type { RoundDecisionLog } from "./decision-log.js";
import { ANSWERED_BY_REC } from "./round-nudge.js";
import { withdrawRound } from "./round-withdraw.js";
import { submitPipeline } from "./rounds-submit.js";

const SPAWN_TIMEOUT_MS = 30_000;

const recommendation = (answer: string | number) => ({ answer, rationale: "The fixture agent prefers it.", confidence: 0.6, by: "fixture-agent" });
const RAMP = { id: "ramp", kind: "pick-one", prompt: "Which ramp by default?", options: ["Staged", "Single"], required: true, signsOff: "ramp-part", recommendation: recommendation("Staged") };
const HOLD = { id: "hold", kind: "scale", prompt: "How clear is the hold step?", min: 1, max: 5, recommendation: recommendation(4) };
const NOTES = { id: "notes", kind: "text", prompt: "Anything else?" };
const SHIP = {
  id: "ship", kind: "pick-one", prompt: "Ship example/kiln#3 at 0123456789ab?", options: ["Ship", "Don't ship"], required: true, page: "example/kiln#3", signsOff: "ship-part",
  merge: { repo: "example/kiln", pr: 3, headSha: "0123456789abcdef0123456789abcdef01234567", ship: ["Ship"] }, recommendation: recommendation("Ship"),
};

type QuestionFixture = Record<string, unknown> & { id: string };

function manifest(unit: string, questions: readonly QuestionFixture[]) {
  return {
    schema: "titan-review/round@2", unit, round: 1, storybookUrl: "http://127.0.0.1:6006", context: "A synthetic kiln round.", widths: [1280], variants: [], recommendations: "shown",
    sections: [{
      id: "main", title: "Main", deciding: "The defaults.", changed: "Nothing real.", context: "Synthetic.", questionIds: questions.map((question) => question.id),
      parts: questions.flatMap((question) => (typeof question.signsOff === "string" ? [{ id: question.signsOff, label: question.id, proposed: question.id }] : [])),
    }],
    questions,
  };
}

let root: string;
let config: ConsoleConfig;
let recorded: unknown[];
let heard: string[];

async function stageRound(id: string, questions: readonly QuestionFixture[]): Promise<void> {
  await mkdir(path.join(config.roundsDir, id), { recursive: true });
  await writeFile(path.join(config.roundsDir, id, "round.json"), JSON.stringify(manifest(id.replace(/-r1$/, ""), questions)));
}

function spyPipeline() {
  const log: RoundDecisionLog = {
    record: async () => ({ ledger: "written", decisions: "not-a-decision" }),
    recordAll: async (entries) => entries.map(({ item }) => (recorded.push(item), { ledger: "written" as const, decisions: "not-a-decision" as const })),
    recordLiveViewed: async () => "written",
  };
  return submitPipeline({ dir: config.roundsDir }, log, { afterRoundSubmit: async (id) => void heard.push(id), sweep: async () => undefined });
}

async function runAnswerRec(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const args = roundsAnswerRecArgs(["rounds", "answer-rec", ...argv]);
  if (args === null) throw new Error("unparsed argv");
  await answerRecCli(config, args, spyPipeline());
  const result = { exitCode: Number(process.exitCode ?? 0), stdout: log.mock.calls.join("\n"), stderr: error.mock.calls.join("\n") };
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return result;
}

const feedbackFile = (id: string) => path.join(config.roundsDir, id, "feedback.json");
const exists = (file: string) => stat(file).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-cli-answer-rec-"));
  config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state") }, root);
  recorded = [];
  heard = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("titan-console rounds answer-rec", () => {
  it("answers every question with its recommendation, bound to the round.json on disk, and says how many", async () => {
    await stageRound("kiln-r1", [RAMP, HOLD]);
    const roundSha = createHash("sha256").update(await readFile(path.join(config.roundsDir, "kiln-r1", "round.json"))).digest("hex");

    const result = await runAnswerRec(["kiln-r1"]);

    expect(result).toEqual({ exitCode: 0, stdout: "kiln-r1: answered 2 questions; feedback written", stderr: "" });
    const feedback = JSON.parse(await readFile(feedbackFile("kiln-r1"), "utf8"));
    expect(feedback).toMatchObject({ manifestSha256: roundSha, general: ANSWERED_BY_REC });
    expect(feedback.answers.map(({ questionId, agreed }: Record<string, unknown>) => ({ questionId, agreed }))).toEqual([
      { questionId: "ramp", agreed: true },
      { questionId: "hold", agreed: true },
    ]);
    expect(recorded).toHaveLength(2);
    expect(heard).toEqual(["kiln-r1"]);
  });

  it("prints one JSON object with --json", async () => {
    await stageRound("kiln-r1", [RAMP]);

    const result = await runAnswerRec(["--json", "kiln-r1"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "kiln-r1", answered: 1, path: feedbackFile("kiln-r1"), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("refuses a withdrawn round with one line and a non-zero exit", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await withdrawRound(config.roundsDir, "kiln-r1", "closed");

    const result = await runAnswerRec(["kiln-r1"]);

    expect(result).toEqual({ exitCode: EXIT.DATAERR, stdout: "", stderr: "refused: withdrawn; only an open round takes the one-tap answer" });
    expect(await exists(feedbackFile("kiln-r1"))).toBe(false);
  });

  it("refuses a round already answered and keeps its first feedback", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await runAnswerRec(["kiln-r1"]);
    const first = await readFile(feedbackFile("kiln-r1"), "utf8");

    const result = await runAnswerRec(["kiln-r1"]);

    expect(result).toEqual({ exitCode: EXIT.DATAERR, stdout: "", stderr: "refused: sent; only an open round takes the one-tap answer" });
    expect(await readFile(feedbackFile("kiln-r1"), "utf8")).toBe(first);
    expect(heard).toEqual(["kiln-r1"]);
  });

  it("refuses a round with a Ship question, which is answered on the round page", async () => {
    await stageRound("ship-r1", [SHIP]);

    const result = await runAnswerRec(["ship-r1"]);

    expect(result).toEqual({ exitCode: EXIT.DATAERR, stdout: "", stderr: 'no one-tap answer: question "ship" is a Ship decision, answered on the round page' });
    expect(await exists(feedbackFile("ship-r1"))).toBe(false);
  });

  it("refuses a round with a text question no recommendation answers", async () => {
    await stageRound("kiln-r1", [RAMP, NOTES]);

    const result = await runAnswerRec(["kiln-r1"]);

    expect(result).toEqual({ exitCode: EXIT.DATAERR, stdout: "", stderr: 'no one-tap answer: question "notes" has no recommendation that answers it' });
    expect(await exists(feedbackFile("kiln-r1"))).toBe(false);
  });

  it("refuses an unknown round id", async () => {
    const result = await runAnswerRec(["kiln-r9"]);

    expect(result).toEqual({ exitCode: EXIT.NOINPUT, stdout: "", stderr: 'No round named "kiln-r9"' });
    expect(recorded).toEqual([]);
  });
});

describe("the titan-console bin", () => {
  it("routes rounds answer-rec and exits non-zero on a refusal", { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const env = { ...process.env, TITAN_CONSOLE_STATE: path.join(root, "bin-state"), TITAN_CONSOLE_HOST: "", TITAN_CONSOLE_ROUNDS_DIR: "" };
    const run = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "rounds", "answer-rec", "kiln-r9"], { cwd: path.join(import.meta.dirname, ".."), env }, (err, stdout, stderr) =>
        resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
      );
    });

    expect(await run).toEqual({ code: EXIT.NOINPUT, stdout: "", stderr: 'No round named "kiln-r9"\n' });
  });
});

describe("rounds answer-rec args", () => {
  it("takes one round id with at most --json", () => {
    expect(roundsAnswerRecArgs(["rounds", "answer-rec", "kiln-r1"])).toEqual({ id: "kiln-r1", json: false });
    expect(roundsAnswerRecArgs(["rounds", "answer-rec", "kiln-r1", "--json"])).toEqual({ id: "kiln-r1", json: true });
    expect(roundsAnswerRecArgs(["rounds", "answer-rec"])).toBeNull();
    expect(roundsAnswerRecArgs(["rounds", "answer-rec", "kiln-r1", "kiln-r2"])).toBeNull();
    expect(roundsAnswerRecArgs(["rounds", "answer-rec", "--apply"])).toBeNull();
  });
});
