import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BY_REC_POLICY_SCHEMA, byRecRowSchema } from "@titan-design/owner-queue";
import { BY_REC_POLICY_FILE, BY_REC_ROWS_FILE } from "./by-rec-log.js";
import { BY_REC_MARKERS, sweepByRecRounds } from "./by-rec-rounds.js";
import { ANSWERS_FILE, createDecisionLog, type DecisionLog, type RoundDecisionLog } from "./decision-log.js";
import { settledListeners } from "./round-fixtures.js";
import { ANSWERED_BY_REC, AUTO_BY_REC } from "./round-nudge.js";
import { submitPipeline } from "./rounds-submit.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const recommendation = (answer: string | number | string[]) => ({ answer, rationale: "The fixture agent prefers it.", confidence: 0.6, by: "fixture-agent" });

const RAMP = { id: "ramp", kind: "pick-one", prompt: "Which ramp by default?", options: ["Staged", "Single"], required: true, signsOff: "ramp-part", recommendation: recommendation("Staged") };
const HOLD = { id: "hold", kind: "scale", prompt: "How clear is the hold step?", min: 1, max: 5, recommendation: recommendation(4) };
const NOTES = { id: "notes", kind: "text", prompt: "Anything else?" };
const SHIP = {
  id: "ship", kind: "pick-one", prompt: "Ship example/kiln#3 at 0123456789ab?", options: ["Ship", "Don't ship"], required: true, page: "example/kiln#3", signsOff: "ship-part",
  merge: { repo: "example/kiln", pr: 3, headSha: "0123456789abcdef0123456789abcdef01234567", ship: ["Ship"] }, recommendation: recommendation("Ship"),
};
const RAMP_PLAN = { planApprovals: [{ questionId: "ramp", approve: "Staged", task: "example/TP-1", repo: "example-org/example-repo", gate: "skill", scope: { paths: [".claude/skills/example/SKILL.md"] } }] };

type QuestionFixture = Record<string, unknown> & { id: string };

function manifest(unit: string, questions: readonly QuestionFixture[], recommendations: string, extra: Record<string, unknown>) {
  return {
    ...extra,
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
let stateDir: string;

async function stageRound(id: string, questions: readonly QuestionFixture[], { ageMs = 24 * HOUR, recommendations = "shown", extra = {} } = {}): Promise<void> {
  const roundDir = path.join(dir, id);
  await mkdir(roundDir);
  const file = path.join(roundDir, "round.json");
  await writeFile(file, JSON.stringify(manifest(id.replace(/-r1$/, ""), questions, recommendations, extra)));
  const opened = new Date(NOW - ageMs);
  await utimes(file, opened, opened);
}

const writePolicy = (mode: string) => writeFile(path.join(stateDir, BY_REC_POLICY_FILE), JSON.stringify({ schema: BY_REC_POLICY_SCHEMA, mode }));

function harness() {
  const recorded: Parameters<DecisionLog["record"]>[] = [];
  const decisionLog: RoundDecisionLog = {
    record: async (...args) => (recorded.push(args), { ledger: "written", decisions: "not-a-decision" }),
    recordAll: async (entries) => entries.map(({ item, answer }) => (recorded.push([item, answer]), { ledger: "written" as const, decisions: "not-a-decision" as const })),
    recordLiveViewed: async () => "written",
  };
  const heard: string[] = [];
  const listeners = settledListeners({ afterRoundSubmit: async (id) => void heard.push(id), sweep: async () => undefined });
  const submit = submitPipeline({ dir }, decisionLog, listeners);
  return { sweep: (at = NOW) => sweepByRecRounds({ dir, stateDir, submit, now: new Date(at) }), recorded, heard, listeners };
}

const exists = (file: string) => stat(file).then(() => true, () => false);
const feedbackOf = async (id: string) => JSON.parse(await readFile(path.join(dir, id, "feedback.json"), "utf8"));
async function rows() {
  const text = await readFile(path.join(stateDir, BY_REC_ROWS_FILE), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => byRecRowSchema.parse(JSON.parse(line)));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "by-rec-rounds-"));
  dir = path.join(root, "rounds");
  stateDir = path.join(root, "state");
  await mkdir(dir);
  await mkdir(stateDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the rounds by-rec sweep, live", () => {
  beforeEach(() => writePolicy("live"));

  it("answers a round silent for 24 h once, through rounds.submit, marked auto-by-rec and credited to automation", async () => {
    await stageRound("kiln-r1", [RAMP, HOLD]);
    const run = harness();

    const report = await run.sweep();
    await run.listeners.settled();

    expect(report.outcomes).toEqual([{ roundId: "kiln-r1", result: "resolved" }]);
    const feedback = await feedbackOf("kiln-r1");
    expect(feedback.general).toBe(AUTO_BY_REC);
    expect(feedback.general).not.toBe(ANSWERED_BY_REC);
    expect(feedback.answers.map(({ questionId, agreed }: Record<string, unknown>) => ({ questionId, agreed }))).toEqual([{ questionId: "ramp", agreed: true }, { questionId: "hold", agreed: true }]);
    expect(run.recorded.map(([, answer]) => answer.by)).toEqual([0, 1].map(() => ({ class: "automation", id: "auto-by-rec", channel: "round" })));
    expect(run.heard).toEqual(["kiln-r1"]);
    expect((await rows()).map(({ subject, mode, result, resolver }) => ({ id: subject.id, mode, result, resolver }))).toEqual(
      ["round:kiln-r1/ramp", "round:kiln-r1/hold"].map((id) => ({ id, mode: "live", result: "resolved", resolver: { class: "automation", id: "auto-by-rec" } })),
    );
  });

  it("leaves the decider's ledger empty when the real decision log records its answer", async () => {
    await stageRound("kiln-r1", [RAMP]);
    const decisionLog = createDecisionLog({ stateDir, decisionsFile: null, humanOnly: async () => ({ known: true, initiatives: new Set() }) });
    const submit = submitPipeline({ dir }, decisionLog);

    const report = await sweepByRecRounds({ dir, stateDir, submit, now: new Date(NOW) });

    expect(report.outcomes).toEqual([{ roundId: "kiln-r1", result: "resolved" }]);
    expect(await exists(path.join(stateDir, ANSWERS_FILE))).toBe(false);
  });

  it("does not answer a round one minute short of 24 h", async () => {
    await stageRound("kiln-r1", [RAMP], { ageMs: 24 * HOUR - 60_000 });

    const report = await harness().sweep();

    expect(report.outcomes).toEqual([{ roundId: "kiln-r1", result: "skipped", reason: 'question "ramp": too-early', waiting: true }]);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
  });

  it("does not answer again after a restart, even when the feedback file is gone", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await harness().sweep();
    await rm(path.join(dir, "kiln-r1", "feedback.json"));
    const restarted = harness();

    const report = await restarted.sweep(NOW + HOUR);

    expect(report.outcomes).toEqual([{ roundId: "kiln-r1", result: "skipped", reason: "claimed", waiting: true }]);
    expect(restarted.recorded).toEqual([]);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    ["an after-answer round", [RAMP], { recommendations: "after-answer" }, 'question "ramp": floor:blind'],
    ["a Ship question", [SHIP], {}, 'question "ship": floor:ship'],
    ["a plan approval", [RAMP], { extra: RAMP_PLAN }, 'question "ramp": floor:plan-approval'],
    ["a question with no recommendation", [RAMP, NOTES], {}, 'question "notes": floor:no-recommendation'],
  ])("skips %s with its reason and writes nothing", async (_name, questions, options, reason) => {
    await stageRound("kiln-r1", questions, options);
    const run = harness();

    const report = await run.sweep();

    expect(report.outcomes).toEqual([{ roundId: "kiln-r1", result: "skipped", reason, waiting: false }]);
    expect(run.recorded).toEqual([]);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
    expect(await exists(path.join(dir, "kiln-r1", BY_REC_MARKERS.live))).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("leaves a round the owner already answered alone", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await writeFile(path.join(dir, "kiln-r1", "feedback.json"), "{}");

    expect((await harness().sweep()).outcomes).toEqual([]);
  });
});

describe("the rounds by-rec sweep, by mode", () => {
  it("in shadow, the default with no policy file, writes would-resolve rows only, and live later still answers", async () => {
    await stageRound("kiln-r1", [RAMP]);
    const shadow = harness();

    const first = await shadow.sweep();
    const second = await shadow.sweep(NOW + HOUR);

    expect(first).toEqual({ mode: "shadow", outcomes: [{ roundId: "kiln-r1", result: "would-resolve" }] });
    expect(second.outcomes).toEqual([{ roundId: "kiln-r1", result: "skipped", reason: "claimed", waiting: true }]);
    expect(shadow.recorded).toEqual([]);
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
    expect((await rows()).map(({ mode, result }) => ({ mode, result }))).toEqual([{ mode: "shadow", result: "would-resolve" }]);

    await writePolicy("live");
    expect((await harness().sweep(NOW + 2 * HOUR)).outcomes).toEqual([{ roundId: "kiln-r1", result: "resolved" }]);
  });

  it("turns off for mode off and for a policy file that does not parse", async () => {
    await stageRound("kiln-r1", [RAMP]);
    await writePolicy("off");
    const off = await harness().sweep();
    await writeFile(path.join(stateDir, BY_REC_POLICY_FILE), JSON.stringify({ schema: BY_REC_POLICY_SCHEMA, mode: "live", allow: ["g10"] }));

    const unparsed = await harness().sweep();

    expect(off).toEqual({ mode: "off", outcomes: [] });
    expect(unparsed).toMatchObject({ mode: "off", outcomes: [], problem: expect.stringContaining(BY_REC_POLICY_FILE) });
    expect(await exists(path.join(dir, "kiln-r1", "feedback.json"))).toBe(false);
    expect(await rows()).toEqual([]);
  });
});
