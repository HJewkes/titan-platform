import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/registry";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { WITHDRAW_FLAGS, withdrawRound } from "./round-withdraw.js";
import { getRound, listRounds } from "./rounds.js";

const OPEN_ROUND = "kiln-schedule-r2";
const SENT_ROUND = "kiln-schedule-r1";
const AT = new Date("2026-10-01T12:00:00.000Z");
const NEW_HEAD = `new-head:${"c".repeat(40)}`;

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-withdraw-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const withdrawnOf = (id: string) => path.join(dir, id, "withdrawn.json");
const exists = (file: string) => stat(file).then(() => true, () => false);
const statusIn = async (id: string) => (await listRounds({ dir })).rounds.find((round) => round.id === id)?.status;

async function refusal(run: Promise<unknown>): Promise<{ message: string; code: unknown }> {
  const error: unknown = await run.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof Error)) throw new Error("expected the withdraw to be refused");
  return { message: error.message, code: "code" in error ? error.code : undefined };
}

describe("withdrawRound", () => {
  it("writes withdrawn.json at mode 0600 and lists and serves the round as withdrawn", async () => {
    const result = await withdrawRound(dir, OPEN_ROUND, NEW_HEAD, AT);

    expect(result).toEqual({ id: OPEN_ROUND, outcome: "withdrawn" });
    expect((await stat(withdrawnOf(OPEN_ROUND))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(withdrawnOf(OPEN_ROUND), "utf8"))).toEqual({ schema: "titan-console/withdrawn@1", reason: NEW_HEAD, at: AT.toISOString() });
    expect(await statusIn(OPEN_ROUND)).toBe("withdrawn");
    expect(await getRound({ dir }, OPEN_ROUND)).toMatchObject({ status: "withdrawn", recommendationsWithheld: true });
  });

  it("keeps an answered round answered and writes nothing", async () => {
    const result = await withdrawRound(dir, SENT_ROUND, "closed", AT);

    expect(result).toEqual({ id: SENT_ROUND, outcome: "kept-answered" });
    expect(await exists(withdrawnOf(SENT_ROUND))).toBe(false);
    expect(await statusIn(SENT_ROUND)).toBe("sent");
  });

  it("treats a second withdraw as done and keeps the first reason", async () => {
    await withdrawRound(dir, OPEN_ROUND, "closed", AT);

    const second = await withdrawRound(dir, OPEN_ROUND, "answered-elsewhere", new Date("2026-10-02T00:00:00.000Z"));

    expect(second).toEqual({ id: OPEN_ROUND, outcome: "already-withdrawn" });
    expect(JSON.parse(await readFile(withdrawnOf(OPEN_ROUND), "utf8"))).toMatchObject({ reason: "closed", at: AT.toISOString() });
  });

  it("opens withdrawn.json create-exclusive and without following a symlink", () => {
    expect(WITHDRAW_FLAGS & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(WITHDRAW_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it("refuses a symlink planted at withdrawn.json and writes nothing through it", async () => {
    const target = path.join(root, "elsewhere.json");
    await symlink(target, withdrawnOf(OPEN_ROUND));

    const { message, code } = await refusal(withdrawRound(dir, OPEN_ROUND, "closed", AT));

    expect(message).toBe("withdraw refused: withdrawn.json is a symlink or not a regular file");
    expect(code).toBe(EXIT.DATAERR);
    expect(await exists(target)).toBe(false);
    expect(await statusIn(OPEN_ROUND)).toBe("open");
  });

  it("refuses a symlinked round directory", async () => {
    await symlink(path.join(dir, OPEN_ROUND), path.join(dir, "linked-r1"));

    const { message, code } = await refusal(withdrawRound(dir, "linked-r1", "closed", AT));

    expect(message).toBe("withdraw refused: linked-r1 in the rounds dir is a symlink or not a directory");
    expect(code).toBe(EXIT.DATAERR);
    expect(await exists(withdrawnOf(OPEN_ROUND))).toBe(false);
  });

  it.each([
    ["../kiln-schedule-r2", "closed", EXIT.DATAERR, /is not a plain name/],
    [".hidden", "closed", EXIT.DATAERR, /is not a plain name/],
    ["no-such-r1", "closed", EXIT.NOINPUT, /no round named "no-such-r1"/],
    [OPEN_ROUND, "superseded", EXIT.USAGE, /reason "superseded"/],
    [OPEN_ROUND, "new-head:abc", EXIT.USAGE, /reason "new-head:abc"/],
  ])("refuses id %j with reason %j and writes nothing", async (id, reason, expectedCode, expectedMessage) => {
    const before = await readdir(dir);

    const { message, code } = await refusal(withdrawRound(dir, id, reason, AT));

    expect(code).toBe(expectedCode);
    expect(message).toMatch(expectedMessage);
    expect(await readdir(dir)).toEqual(before);
    expect(await exists(withdrawnOf(OPEN_ROUND))).toBe(false);
  });

  it("does not count a withdrawn.json that is not a regular file", async () => {
    await mkdir(withdrawnOf(OPEN_ROUND));

    expect(await statusIn(OPEN_ROUND)).toBe("open");
  });

  it("lists a round answered after a racing withdraw as sent", async () => {
    await withdrawRound(dir, OPEN_ROUND, "closed", AT);
    await writeFile(path.join(dir, OPEN_ROUND, "feedback.json"), "{}");

    expect(await statusIn(OPEN_ROUND)).toBe("sent");
  });
});
