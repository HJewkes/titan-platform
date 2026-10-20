import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoundListeners, type ListenerDeps } from "./listeners.js";
import { answerNotice } from "./round-asker.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { fileRound } from "./round-file.js";

// Synthetic: a questions-only fixture round filed by a made-up seat.
const ROUND = "kiln-schedule-r2";
const SEAT = "sample-seat";
const NOW = new Date("2026-10-20T12:00:00.000Z");

let roundsDir: string;
let sent: { seat: string; text: string }[];

beforeEach(async () => {
  roundsDir = path.join(await mkdtemp(path.join(tmpdir(), "console-round-asker-")), "rounds");
  sent = [];
});

afterEach(async () => {
  await rm(path.dirname(roundsDir), { recursive: true, force: true });
});

const recordingNotify = async (seat: string, text: string): Promise<void> => {
  sent.push({ seat, text });
};

function listeners(overrides: Partial<ListenerDeps> = {}) {
  const unused = () => Promise.reject(new Error("no factory in this test"));
  return createRoundListeners({ enabled: false, roundsDir, shepherd: { list: unused }, answer: { post: unused }, notify: recordingNotify, now: () => NOW, ...overrides });
}

const roundDir = () => path.join(roundsDir, ROUND);
const feedbackPath = () => path.join(roundDir(), "feedback.json");
const exists = (file: string) => stat(file).then(() => true, () => false);

async function fileAndAnswer(): Promise<void> {
  const body = await readFile(path.join(FIXTURE_ROUNDS.dir, ROUND, "round.json"), "utf8");
  await fileRound({ body, roundsDir, asker: { seat: SEAT, initiative: null } });
  await writeFile(feedbackPath(), "{}\n");
}

describe("telling the asking seat its decision round was answered", () => {
  it("messages the seat once after the submit, with gate answers off, and records the notice", async () => {
    await fileAndAnswer();
    const listener = listeners();

    await listener.afterRoundSubmit(ROUND, { status: "submitted" });
    await listener.sweep();

    expect(sent).toEqual([{ seat: SEAT, text: answerNotice(ROUND, feedbackPath()) }]);
    expect(JSON.parse(await readFile(path.join(roundDir(), "notified.json"), "utf8"))).toEqual({ schema: "titan-console/notified@1", seat: SEAT, at: NOW.toISOString() });
  });

  it("names the round and the feedback file, and nothing the filing seat wrote", () => {
    expect(answerNotice(ROUND, "/state/rounds/kiln-schedule-r2/feedback.json")).toBe(
      "titan-console: the owner answered your decision round kiln-schedule-r2. The answers are in /state/rounds/kiln-schedule-r2/feedback.json (titan-review/feedback@1).",
    );
  });

  it("tells no one about a round that has no asker record", async () => {
    await fileAndAnswer();
    await rm(path.join(roundDir(), "asker.json"));

    await listeners().afterRoundSubmit(ROUND, { status: "submitted" });

    expect(sent).toEqual([]);
  });

  it("tells no one on an already-submitted answer", async () => {
    await fileAndAnswer();

    await listeners().afterRoundSubmit(ROUND, { status: "already-submitted" });

    expect(sent).toEqual([]);
  });

  it("writes no notice when the send fails, so the start-up sweep sends it", async () => {
    await fileAndAnswer();
    const warnings: string[] = [];
    const failing = listeners({ notify: () => Promise.reject(new Error("no live session")), logger: { warn: (_fields, message) => warnings.push(message) } });

    await failing.afterRoundSubmit(ROUND, { status: "submitted" });
    expect(await exists(path.join(roundDir(), "notified.json"))).toBe(false);
    expect(warnings).toEqual([`${ROUND}: the asking seat was not told of the answer (no live session)`]);

    await listeners().sweep();
    expect(sent).toHaveLength(1);
  });

  it("does not message the seat before the owner answers", async () => {
    await fileAndAnswer();
    await rm(feedbackPath());

    await listeners().sweep();

    expect(sent).toEqual([]);
  });
});
