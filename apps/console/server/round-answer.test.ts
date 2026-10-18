import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { getRound } from "./rounds.js";

const ROUND = "kiln-schedule-r2";
const SCHEMA = "titan-console/gate-answer@1";
const AT = "2030-01-02T03:04:05.000Z";
const HEAD = "a".repeat(40);

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-answer-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const answerFile = (): string => path.join(dir, ROUND, "answer.json");
const record = (outcome: unknown, schema = SCHEMA): string =>
  JSON.stringify({ schema, at: AT, request: { runId: "run-1", gateId: "gate-1", headSha: HEAD, choice: "merge" }, outcome });

async function answerFor(text: string): Promise<unknown> {
  await writeFile(answerFile(), text);
  const detail = await getRound({ dir }, ROUND);
  expect(detail.valid).toBe(true);
  return "answer" in detail ? detail.answer : undefined;
}

describe("rounds.get answer", () => {
  it.each([
    ["resolved", { status: "resolved", gateId: "gate-1", choice: "send-back" }, { status: "resolved", at: AT, choice: "send-back" }],
    ["resolved accept-set", { status: "resolved", gateId: "gate-1", choice: "accept-set" }, { status: "resolved", at: AT, choice: "accept-set" }],
    ["already", { status: "already", gateId: "gate-1" }, { status: "already", at: AT }],
    ["moved", { status: "moved", currentHead: HEAD, waitsOn: "ci" }, { status: "moved", at: AT, currentHead: HEAD }],
    ["gone", { status: "gone", reason: "no pending gate" }, { status: "gone", at: AT, reason: "no pending gate" }],
    ["refused", { status: "refused", reason: "not owner", detail: "x" }, { status: "refused", at: AT, reason: "not owner" }],
    ["off", { status: "off" }, { status: "off", at: AT }],
  ])("maps a %s outcome to its detail fields only", async (_name, outcome, expected) => {
    expect(await answerFor(record(outcome))).toEqual(expected);
  });

  it("has no answer when answer.json is absent", async () => {
    const detail = await getRound({ dir }, ROUND);

    expect(detail.valid && detail.answer).toBeFalsy();
  });

  it("has no answer when answer.json is a symlink, and the round still loads", async () => {
    const target = path.join(root, "elsewhere.json");
    await writeFile(target, record({ status: "off" }));
    await symlink(target, answerFile());

    const detail = await getRound({ dir }, ROUND);

    expect(detail.valid && detail.answer).toBeFalsy();
  });

  it("has no answer when answer.json is not JSON", async () => {
    expect(await answerFor("{ not json")).toBeUndefined();
  });

  it("has no answer when the schema id is wrong", async () => {
    expect(await answerFor(record({ status: "off" }, "titan-console/other@1"))).toBeUndefined();
  });

  it("has no answer when answer.json is over 64 KiB", async () => {
    expect(await answerFor(record({ status: "gone", reason: "x".repeat(70 * 1024) }))).toBeUndefined();
  });
});
