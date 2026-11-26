import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BY_REC_FLOOR, BY_REC_POLICY_SCHEMA, type OwnerItem } from "@titan-design/owner-queue";
import { BY_REC_POLICY_FILE } from "./by-rec-log.js";
import { sweepByRecRounds } from "./by-rec-rounds.js";
import { withByRecCountdown } from "./inbox-by-rec.js";
import { floorClasses } from "./log-floor.js";
import { submitPipeline } from "./rounds-submit.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ROUND = "kiln-r1";

const recommendation = (answer: string | number | string[]) => ({ answer, rationale: "The fixture agent prefers it.", confidence: 0.6, by: "fixture-agent" });
const RAMP = { id: "ramp", kind: "pick-one", prompt: "Which ramp by default?", options: ["Staged", "Single"], signsOff: "ramp-part", recommendation: recommendation("Staged") };
const HOLD = { id: "hold", kind: "scale", prompt: "How clear is the hold step?", min: 1, max: 5, recommendation: recommendation(4) };
const PICKS = { id: "picks", kind: "pick-many", prompt: "Which retries stay?", options: ["a", "b", "c"], recommendation: recommendation(["a", "b"]) };
const BARE = { id: "bare", kind: "pick-one", prompt: "Which colour?", options: ["Red", "Blue"], signsOff: "bare-part" };
const PLAN = { planApprovals: [{ questionId: "ramp", approve: "Staged", task: "example/TP-1", repo: "example-org/example-repo", gate: "skill", scope: { paths: [".claude/skills/example/SKILL.md"] } }] };

type Question = Record<string, unknown> & { id: string };

interface Fixture {
  questions: Question[];
  extra?: Record<string, unknown>;
  sectionContext?: string;
}

let root: string;
let dir: string;
let stateDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "inbox-by-rec-"));
  dir = path.join(root, "rounds");
  stateDir = path.join(root, "state");
  await mkdir(dir);
  await mkdir(stateDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manifest({ questions, extra = {}, sectionContext = "Synthetic." }: Fixture) {
  return {
    ...extra,
    schema: "titan-review/round@2", unit: "kiln", round: 1, storybookUrl: "http://127.0.0.1:6006", context: "A synthetic kiln round.", widths: [1280], variants: [], recommendations: "shown",
    sections: [{ id: "main", title: "Main", deciding: "The defaults.", changed: "Nothing real.", context: sectionContext, questionIds: questions.map((question) => question.id),
      parts: questions.flatMap((question) => (typeof question.signsOff === "string" ? [{ id: question.signsOff, label: question.id, proposed: question.id }] : [{ id: `${question.id}-part`, label: question.id, proposed: question.id }])),
    }],
    questions,
  };
}

/** Writes the round `ageMs` ago and lets a sweep first see it then, as the hourly timer would. */
async function stageRound(fixture: Fixture, ageMs = 25 * HOUR): Promise<void> {
  const file = path.join(dir, ROUND, "round.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest(fixture)));
  const opened = new Date(NOW - ageMs);
  await utimes(file, opened, opened);
  await sweepByRecRounds({ dir, stateDir, submit: () => Promise.reject(new Error("a first sighting never submits")), now: opened });
}

const writePolicy = (mode: string) => writeFile(path.join(stateDir, BY_REC_POLICY_FILE), JSON.stringify({ schema: BY_REC_POLICY_SCHEMA, mode }));

function item(system: OwnerItem["sources"][number]["system"], ref: string): OwnerItem {
  return {
    id: `${system}:${ref}`, sources: [{ system, ref }], kind: "decide", door: "two-way", summary: "Keep the ceiling?", context: "", keys: [], personal: false,
    lens: "blocking-agent", unblocks: [], openedAt: "2031-03-04T02:00:00.000Z", status: "open",
    options: [{ id: "keep", label: "keep" }, { id: "raise", label: "raise" }], recommended: { optionId: "keep", by: "builder" },
  };
}

const roundItem = (questionId: string): OwnerItem => item("round", `${ROUND}#${questionId}`);
const pillOf = async (items: OwnerItem[], at = NOW) => (await withByRecCountdown(items, { stateDir, roundsDir: dir }, at)).map((each) => each.byRec);

describe("the inbox by-rec countdown agrees with the rounds sweep", () => {
  beforeEach(() => writePolicy("live"));

  it.each<[string, Fixture, boolean]>([
    ["a round with every question recommended", { questions: [RAMP, HOLD] }, true],
    ["a section context naming dollars, with neutral prompt and options", { questions: [RAMP], sectionContext: "This adds $400/month." }, false],
    ["a pick-many question", { questions: [PICKS] }, false],
    ["a scale too wide to check", { questions: [{ ...HOLD, min: 0, max: 1000 }] }, false],
    ["a plan approval", { questions: [RAMP], extra: PLAN }, false],
    ["a partly recommended round", { questions: [RAMP, BARE] }, false],
  ])("for %s", async (_name, fixture, resolves) => {
    await stageRound(fixture);
    const questionIds = fixture.questions.map((question) => question.id);

    const pills = await pillOf(questionIds.map(roundItem));
    const report = await sweepByRecRounds({ dir, stateDir, submit: submitPipeline({ dir }), now: new Date(NOW) });

    expect(report.outcomes.map(({ result }) => result)).toEqual([resolves ? "resolved" : "skipped"]);
    expect(pills).toEqual(questionIds.map(() => (resolves ? { at: "2031-03-05T11:00:00.000Z", mode: "live" } : undefined)));
  });

  it("shows when a round still inside its wait will go, while the sweep waits", async () => {
    await stageRound({ questions: [RAMP] }, 2 * HOUR);

    const pills = await pillOf([roundItem("ramp")]);
    const report = await sweepByRecRounds({ dir, stateDir, submit: submitPipeline({ dir }), now: new Date(NOW) });

    expect(pills).toEqual([{ at: "2031-03-06T10:00:00.000Z", mode: "live" }]);
    expect(report.outcomes).toEqual([{ roundId: ROUND, result: "skipped", reason: 'question "ramp": too-early', waiting: true }]);
  });
});

describe("the inbox by-rec countdown", () => {
  it("says would go in shadow, the default with no policy file", async () => {
    await stageRound({ questions: [RAMP] });

    expect(await pillOf([roundItem("ramp")])).toEqual([{ at: "2031-03-05T11:00:00.000Z", mode: "shadow" }]);
  });

  it("shows on no deposit or gate, which no console sweep resolves, and on nothing in mode off", async () => {
    await stageRound({ questions: [RAMP] });
    await writePolicy("live");

    expect(await pillOf([item("deposit", "builder/dep-1"), item("hitl", "run-1/approve-merge")])).toEqual([undefined, undefined]);
    await writePolicy("off");
    expect(await pillOf([roundItem("ramp")])).toEqual([undefined]);
  });
});

describe("the log's floor list", () => {
  it("words every floor class owner-queue holds", () => {
    expect(floorClasses().map((floor) => floor.reason)).toEqual(BY_REC_FLOOR.map(([reason]) => reason));
    expect(floorClasses().filter((floor) => floor.label === floor.reason)).toEqual([]);
  });
});
