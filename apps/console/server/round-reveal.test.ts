import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand } from "@titan-design/registry";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { REVEALED_FILE, roundsRevealCommands } from "./round-reveal.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import { getRound } from "./rounds.js";

const ROUND = "kiln-schedule-r2";
const SHOWN = "orbit-retry-r1";
const RAMP_RECOMMENDATION = { answer: "Staged climb", rationale: "Staged climbs cracked fewer test tiles in the sample firings.", confidence: 0.7, by: "fixture-agent" };
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };

let root: string;
let dir: string;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const manifestSha = async (id = ROUND): Promise<string> => sha256(await readFile(path.join(dir, id, "round.json")));

async function reveal(questionId: string, overrides: Record<string, unknown> = {}) {
  const args = { id: ROUND, manifestSha256: await manifestSha(), questionId, ...overrides };
  return invokeCommand(roundsRevealCommands({ dir })["rounds.reveal"], args, OWNER);
}

async function submit(answers: unknown[]) {
  return invokeCommand(roundsSubmitCommands({ dir })["rounds.submit"], { id: ROUND, manifestSha256: await manifestSha(), answers }, OWNER);
}

const feedbackAnswers = async () => JSON.parse(await readFile(path.join(dir, ROUND, "feedback.json"), "utf8")).answers;
const revealedIds = async () => JSON.parse(await readFile(path.join(dir, ROUND, REVEALED_FILE), "utf8")).reveals.map((each: { questionId: string }) => each.questionId);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "round-reveal-"));
  dir = path.join(root, "rounds");
  await mkdir(dir);
  for (const id of [ROUND, SHOWN]) await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("rounds.reveal", () => {
  it("leaves rounds.get stripping the recommendation, naming the questions it can reveal", async () => {
    await reveal("ramp-default");

    const detail = await getRound({ dir }, ROUND);
    if (!detail.valid) throw new Error(detail.reason);
    expect(detail.recommendationsWithheld).toBe(true);
    expect(detail.manifest.questions.find((question) => question.id === "ramp-default")).not.toHaveProperty("recommendation");
    expect(detail.revealable).toEqual(["ramp-default", "hold-clarity", "report-columns"]);
  });

  it("hands back the one recommendation asked for and records the reveal once", async () => {
    const first = await reveal("ramp-default");
    const again = await reveal("ramp-default");

    expect(first.envelope).toEqual({ ok: true, data: { recommendation: RAMP_RECOMMENDATION, recorded: true } });
    expect(again.envelope).toEqual({ ok: true, data: { recommendation: RAMP_RECOMMENDATION, recorded: false } });
    expect(await revealedIds()).toEqual(["ramp-default"]);
  });

  it.each([
    ["a round.json that changed since it was shown", "ramp-default", { manifestSha256: "0".repeat(64) }, "round.json has changed since it was shown; reload the round"],
    ["a question with no recommendation", "report-notes", {}, 'question "report-notes" has no recommendation'],
    ["an unknown question", "nope", {}, 'no question "nope" in this round'],
  ])("refuses %s", async (_label, questionId, overrides, error) => {
    const { envelope } = await reveal(questionId, overrides);

    expect(envelope).toMatchObject({ ok: false, error });
  });

  it("refuses a round that shows its recommendations already", async () => {
    const { envelope } = await reveal("ship-backoff", { id: SHOWN, manifestSha256: await manifestSha(SHOWN) });

    expect(envelope).toMatchObject({ ok: false, error: "this round shows every recommendation already" });
  });

  it("refuses a sent round, which rounds.get already shows unstripped", async () => {
    await writeFile(path.join(dir, ROUND, "feedback.json"), "{}");

    const { envelope } = await reveal("ramp-default");

    expect(envelope).toMatchObject({ ok: false, error: "refused: sent; only an open round reveals a recommendation" });
  });
});

describe("rounds.submit after a reveal", () => {
  it("keeps recommendationSeen on a revealed question's answer, with its echo and a differs verdict", async () => {
    await reveal("ramp-default");

    const { envelope } = await submit([{ questionId: "ramp-default", pick: "Single slope", recommendationSeen: true }]);

    expect(envelope.ok).toBe(true);
    expect((await feedbackAnswers())[0]).toEqual({ questionId: "ramp-default", pick: "Single slope", recommendationSeen: true, recommendation: RAMP_RECOMMENDATION, agreed: false });
  });

  it("refuses recommendationSeen on a question whose recommendation was never revealed", async () => {
    await reveal("ramp-default");

    const { envelope } = await submit([{ questionId: "hold-clarity", value: 4, recommendationSeen: true }]);

    expect(envelope).toMatchObject({ ok: false, error: 'question "hold-clarity" is tagged recommendationSeen, but its recommendation was never revealed' });
  });

  it("writes a revealed question answered without the tag as blind, agreeing where it matches", async () => {
    await reveal("ramp-default");

    await submit([{ questionId: "ramp-default", pick: "Staged climb" }]);

    expect((await feedbackAnswers())[0]).toEqual({ questionId: "ramp-default", pick: "Staged climb", recommendation: RAMP_RECOMMENDATION, agreed: true });
  });
});
