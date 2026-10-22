import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand } from "@titan-design/registry";
import { nudgeRounds, roundsNudgeArgs } from "./cli-rounds-nudge.js";
import type { DecisionLog, RoundDecisionLog } from "./decision-log.js";
import type { ConsoleContext } from "./owner-guard.js";
import { settledListeners } from "./round-fixtures.js";
import { ANSWERED_BY_REC, NUDGE_AFTER_MS, NUDGED_FILE, roundNudges } from "./round-nudge.js";
import { roundsAnswerRecCommands } from "./round-rec-answer.js";
import { withdrawRound } from "./round-withdraw.js";
import { readQueueRounds } from "./rounds.js";
import { submitPipeline } from "./rounds-submit.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };

const recommendation = (answer: string | number | string[]) => ({ answer, rationale: "The fixture agent prefers it.", confidence: 0.6, by: "fixture-agent" });

const RAMP = { id: "ramp", kind: "pick-one", prompt: "Which ramp by default?", options: ["Staged", "Single"], required: true, signsOff: "ramp-part", recommendation: recommendation("Staged") };
const HOLD = { id: "hold", kind: "scale", prompt: "How clear is the hold step?", min: 1, max: 5, recommendation: recommendation(4) };
const COLUMNS = { id: "columns", kind: "pick-many", prompt: "Which columns?", options: ["Segment", "Rate", "Hold"], recommendation: recommendation(["Segment", "Hold"]) };
const NOTES = { id: "notes", kind: "text", prompt: "Anything else?" };
const SHIP = {
  id: "ship", kind: "pick-one", prompt: "Ship example/kiln#3 at 0123456789ab?", options: ["Ship", "Don't ship"], required: true, page: "example/kiln#3", signsOff: "ship-part",
  merge: { repo: "example/kiln", pr: 3, headSha: "0123456789abcdef0123456789abcdef01234567", ship: ["Ship"] }, recommendation: recommendation("Ship"),
};

type QuestionFixture = Record<string, unknown> & { id: string };

function manifest(unit: string, questions: readonly QuestionFixture[], recommendations = "after-answer") {
  return {
    schema: "titan-review/round@2", unit, round: 1, storybookUrl: "http://127.0.0.1:6006", context: "A synthetic kiln round.", widths: [1280], variants: [], recommendations,
    sections: [{
      id: "main", title: "Main", deciding: "The defaults.", changed: "Nothing real.", context: "Synthetic.", questionIds: questions.map((question) => question.id),
      parts: questions.flatMap((question) => (typeof question.signsOff === "string" ? [{ id: question.signsOff, label: question.id, proposed: question.id }] : [])),
    }],
    questions,
  };
}

let root: string;
let dir: string;

async function stageRound(id: string, questions: readonly QuestionFixture[], { ageMs = 7 * HOUR, recommendations = "after-answer" } = {}): Promise<string> {
  const roundDir = path.join(dir, id);
  await mkdir(roundDir);
  const file = path.join(roundDir, "round.json");
  await writeFile(file, JSON.stringify(manifest(id.replace(/-r1$/, ""), questions, recommendations)));
  const opened = new Date(NOW - ageMs);
  await utimes(file, opened, opened);
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function nudgesNow(now = NOW) {
  return roundNudges(dir, (await readQueueRounds({ dir })).rounds, now);
}

function spyLog() {
  const recorded: Parameters<DecisionLog["record"]>[] = [];
  const log: RoundDecisionLog = {
    record: async (...args) => (recorded.push(args), { ledger: "written", decisions: "not-a-decision" }),
    recordAll: async (entries) => entries.map(({ item, answer }) => (recorded.push([item, answer]), { ledger: "written" as const, decisions: "not-a-decision" as const })),
    recordLiveViewed: async () => "written",
  };
  return { log, recorded };
}

function answerRec(args: Record<string, unknown>) {
  const { log, recorded } = spyLog();
  const heard: string[] = [];
  const listeners = settledListeners({ afterRoundSubmit: async (id) => void heard.push(id), sweep: async () => undefined });
  const command = roundsAnswerRecCommands({ dir }, submitPipeline({ dir }, log, listeners))["rounds.answer-rec"];
  return { run: () => invokeCommand(command, args, OWNER), recorded, heard, listeners };
}

const feedbackOf = async (id: string) => JSON.parse(await readFile(path.join(dir, id, "feedback.json"), "utf8"));
const exists = (file: string) => stat(file).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "round-nudge-"));
  dir = path.join(root, "rounds");
  await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the round age nudge", () => {
  it("surfaces a 7 h round once in the inbox, with every recommendation stated, and once in the digest", async () => {
    await stageRound("kiln-r1", [RAMP, HOLD, COLUMNS]);

    const inbox = await nudgesNow();
    const first = await nudgeRounds(dir, new Date(NOW));
    const second = await nudgeRounds(dir, new Date(NOW + HOUR));

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ roundId: "kiln-r1", oneTap: true, nudgedAt: null });
    expect(inbox[0]!.recommendations.map((each) => each.answer)).toEqual(["Staged", "4", "Segment, Hold"]);
    expect(inbox[0]!.line).toBe("kiln-r1 has waited 7 h: reply rec to answer all 3 with the recommendation (ramp: Staged; hold: 4; columns: Segment, Hold)");
    expect(first.map((nudge) => nudge.roundId)).toEqual(["kiln-r1"]);
    expect(second).toEqual([]);
    expect((await nudgesNow())[0]!.nudgedAt).toBe(new Date(NOW).toISOString());
  });

  it("does not nudge a round open exactly 6 h, and nudges it a millisecond later", async () => {
    await stageRound("kiln-r1", [RAMP], { ageMs: NUDGE_AFTER_MS });

    expect(await nudgesNow()).toEqual([]);
    expect(await nudgesNow(NOW + 1)).toHaveLength(1);
  });

  it("never nudges a withdrawn round, in the inbox or the digest", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await withdrawRound(dir, "kiln-r1", "closed", new Date(NOW));

    expect(await nudgesNow()).toEqual([]);
    expect(await nudgeRounds(dir, new Date(NOW))).toEqual([]);
    expect(await exists(path.join(dir, "kiln-r1", NUDGED_FILE))).toBe(false);
  });

  it("never nudges an answered round, even one whose feedback.json the queue cannot parse", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await stageRound("kiln-r2", [RAMP]);
    await writeFile(path.join(dir, "kiln-r1", "feedback.json"), "{ not json");
    expect((await answerRec({ id: "kiln-r2", manifestSha256: await stageHash("kiln-r2") }).run()).envelope.ok).toBe(true);

    expect(await nudgesNow()).toEqual([]);
    expect(await nudgeRounds(dir, new Date(NOW))).toEqual([]);
  });

  it("offers no one-tap answer when a question lacks a recommendation, or is a Ship", async () => {
    await stageRound("kiln-r1", [RAMP, NOTES]);
    await stageRound("ship-r1", [SHIP]);

    const nudges = await nudgesNow();

    expect(nudges.map(({ roundId, oneTap, withoutTap }) => ({ roundId, oneTap, withoutTap }))).toEqual([
      { roundId: "kiln-r1", oneTap: false, withoutTap: 'question "notes" has no recommendation that answers it' },
      { roundId: "ship-r1", oneTap: false, withoutTap: 'question "ship" is a Ship decision, answered on the round page' },
    ]);
    expect(nudges[0]!.line).toBe("kiln-r1 has waited 7 h; open it to answer (recommended: ramp: Staged)");
  });
});

async function stageHash(id: string): Promise<string> {
  return createHash("sha256").update(await readFile(path.join(dir, id, "round.json"))).digest("hex");
}

describe("rounds.answer-rec", () => {
  it("answers every question with its recommendation through rounds.submit, marked answered-by-rec", async () => {
    const manifestSha256 = await stageRound("kiln-r1", [RAMP, HOLD, COLUMNS]);
    const tap = answerRec({ id: "kiln-r1", manifestSha256 });

    const { envelope } = await tap.run();
    await tap.listeners.settled();

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", log: [{ questionId: "ramp" }, { questionId: "hold" }, { questionId: "columns" }] } });
    const feedback = await feedbackOf("kiln-r1");
    expect(feedback.general).toBe(ANSWERED_BY_REC);
    expect(feedback.answers.map(({ questionId, agreed, recommendationSeen }: Record<string, unknown>) => ({ questionId, agreed, recommendationSeen }))).toEqual([
      { questionId: "ramp", agreed: true, recommendationSeen: true },
      { questionId: "hold", agreed: true, recommendationSeen: true },
      { questionId: "columns", agreed: true, recommendationSeen: true },
    ]);
    expect(tap.recorded).toHaveLength(3);
    expect(tap.heard).toEqual(["kiln-r1"]);
    expect(JSON.parse(await readFile(path.join(dir, "kiln-r1", "revealed.json"), "utf8")).reveals.map((each: { questionId: string }) => each.questionId)).toEqual(["ramp", "hold", "columns"]);
  });

  it("records no reveal in a round that shows its recommendations", async () => {
    const manifestSha256 = await stageRound("kiln-r1", [RAMP], { recommendations: "shown" });

    expect((await answerRec({ id: "kiln-r1", manifestSha256 }).run()).envelope.ok).toBe(true);
    expect(await exists(path.join(dir, "kiln-r1", "revealed.json"))).toBe(false);
  });

  it("is refused for a round whose question lacks a recommendation, and writes nothing", async () => {
    const manifestSha256 = await stageRound("kiln-r1", [RAMP, NOTES]);

    const { envelope } = await answerRec({ id: "kiln-r1", manifestSha256 }).run();

    expect(envelope).toMatchObject({ ok: false, error: 'no one-tap answer: question "notes" has no recommendation that answers it' });
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
    expect(await exists(path.join(dir, "kiln-r1", "revealed.json"))).toBe(false);
  });

  it("is refused for a withdrawn round and for a round changed since the nudge", async () => {
    const withdrawnSha = await stageRound("kiln-r1", [RAMP]);
    await withdrawRound(dir, "kiln-r1", "closed", new Date(NOW));
    await stageRound("kiln-r2", [RAMP]);

    const withdrawn = answerRec({ id: "kiln-r1", manifestSha256: withdrawnSha });
    const changed = answerRec({ id: "kiln-r2", manifestSha256: "0".repeat(64) });

    expect((await withdrawn.run()).envelope).toMatchObject({ ok: false, error: "refused: withdrawn; only an open round takes the one-tap answer" });
    expect((await changed.run()).envelope).toMatchObject({ ok: false, error: "round.json has changed since it was shown; reload the round" });
    expect(withdrawn.recorded).toEqual([]);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
  });

  it("is refused without the owner-write class", async () => {
    const manifestSha256 = await stageRound("kiln-r1", [RAMP]);
    const command = roundsAnswerRecCommands({ dir }, submitPipeline({ dir }))["rounds.answer-rec"];

    const { envelope } = await invokeCommand(command, { id: "kiln-r1", manifestSha256 }, { ...OWNER, ownerWrites: false });

    expect(envelope.ok).toBe(false);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
  });
});

describe("rounds nudge args", () => {
  it("takes the verb with at most --json", () => {
    expect(roundsNudgeArgs(["rounds", "nudge"])).toEqual({ json: false });
    expect(roundsNudgeArgs(["rounds", "nudge", "--json"])).toEqual({ json: true });
    expect(roundsNudgeArgs(["rounds", "nudge", "--apply"])).toBeNull();
    expect(roundsNudgeArgs(["rounds", "sweep"])).toBeNull();
  });
});
