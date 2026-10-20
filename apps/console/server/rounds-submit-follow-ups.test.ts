import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { depositItemId, ownerItemDepositSchema } from "@titan-design/owner-queue";
import { EXIT, invokeCommand } from "@titan-design/registry";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { FOLLOW_UPS_FILE } from "./round-follow-ups.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import { getRound } from "./rounds.js";

const ROUND = "ship-tile-r1";
const R2 = "ship-tile-r2";
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const R2_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const SIDE = "badge-follow-up";
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };

let root: string;
let dir: string;
let inboxDir: string;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const shaOf = async (id: string): Promise<string> => sha256(await readFile(path.join(dir, id, "round.json")));
const exists = (file: string) => stat(file).then(() => true, () => false);

function submit(args: Record<string, unknown>, withInbox = true) {
  return invokeCommand(roundsSubmitCommands({ dir }, undefined, undefined, withInbox ? inboxDir : undefined)["rounds.submit"], args, OWNER);
}

const sideComment = { questionId: SIDE, pick: "No", comment: "Try the stripe's own colour." };

async function ship(id: string, head: string, overrides: Record<string, unknown> = {}) {
  return submit({ id, manifestSha256: await shaOf(id), headSha: head, answers: [sideComment, { questionId: "ship-tiles", pick: "Ship" }], ...overrides });
}

async function deposits(): Promise<unknown[]> {
  const names = await readdir(inboxDir).catch(() => []);
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(inboxDir, name), "utf8"))));
}

/** Round 2 of the same unit, asking to Ship a new head. */
async function reround(): Promise<void> {
  const round = JSON.parse(await readFile(path.join(dir, ROUND, "round.json"), "utf8"));
  const questions = round.questions.map((question: { merge?: object }) => (question.merge ? { ...question, merge: { repo: "example/tiles", pr: 1, headSha: R2_HEAD, ship: ["Ship"] } } : question));
  await mkdir(path.join(dir, R2));
  await writeFile(path.join(dir, R2, "round.json"), JSON.stringify({ ...round, round: 2, questions }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rounds-follow-ups-"));
  dir = path.join(root, "rounds");
  inboxDir = path.join(root, "inbox");
  await mkdir(dir);
  await cp(path.join(FIXTURE_ROUNDS.dir, ROUND), path.join(dir, ROUND), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a side answer marked follow-up (TP-3346)", () => {
  it("refuses a Ship whose commented side answer is for this PR", async () => {
    const { envelope, exitCode } = await ship(ROUND, HEAD);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: 'Ship refused: you left a comment on "File the badge colour as a follow-up?"' });
  });

  it("ships with the same answer marked follow-up, keeps it in feedback.json and records the mark beside it", async () => {
    const { envelope } = await ship(ROUND, HEAD, { followUps: [SIDE] });

    const item = depositItemId("titan-console", `round-follow-up-${ROUND}-${sha256(Buffer.from(SIDE)).slice(0, 16)}`);
    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: HEAD, followUps: { sidecar: "recorded", filed: [{ questionId: SIDE, item }] } } });
    expect(JSON.parse(await readFile(path.join(dir, ROUND, "feedback.json"), "utf8")).answers[0]).toMatchObject(sideComment);
    expect(JSON.parse(await readFile(path.join(dir, ROUND, FOLLOW_UPS_FILE), "utf8"))).toEqual({ schema: "titan-console/follow-ups@1", questionIds: [SIDE], at: expect.any(String) });
  });

  it("files one owner-inbox item with the answer text and the round and PR", async () => {
    await ship(ROUND, HEAD, { followUps: [SIDE] });

    const [deposit, ...rest] = await deposits();
    expect(rest).toHaveLength(0);
    const parsed = ownerItemDepositSchema.parse(deposit);
    expect(parsed).toMatchObject({ asker: "titan-console", kind: "review", keys: ["round-follow-up"], shown: ["https://github.com/example/tiles/pull/1"] });
    expect(parsed.summary).toBe("Follow-up from example/tiles#1: File the badge colour as a follow-up?");
    expect(parsed.context).toContain(`round ${ROUND}`);
    expect(parsed.context).toContain("Answer: No");
    expect(parsed.context).toContain("Comment: Try the stripe's own colour.");
  });

  it("files the follow-up with a Send back too, and leaves this-PR answers out of it", async () => {
    const answers = [sideComment, { questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is low." }];

    const { envelope } = await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), answers, followUps: [SIDE] });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: null, followUps: { filed: [{ questionId: SIDE }] } } });
    const [deposit] = await deposits();
    expect(JSON.stringify(deposit)).not.toContain("The stripe is low.");
  });

  it("refuses a Send back whose every comment is a follow-up and that has no round note, and writes nothing", async () => {
    const answers = [sideComment, { questionId: "ship-tiles", pick: "Don't ship" }];

    const { envelope, exitCode } = await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), answers, followUps: [SIDE] });

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: "Send back refused: Nothing to fix in this PR: every comment is marked Follow-up. Add a note or Ship." });
    expect(await exists(path.join(dir, ROUND, "feedback.json"))).toBe(false);
    expect(await deposits()).toEqual([]);
  });

  it("takes the same Send back once a round note tells the fixer what to change", async () => {
    const answers = [sideComment, { questionId: "ship-tiles", pick: "Don't ship" }];

    const { envelope } = await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), answers, followUps: [SIDE], general: "The stripe is low." });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: null } });
  });

  it("records the mark but files nothing when the console has no inbox spool", async () => {
    const { envelope } = await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), headSha: HEAD, answers: [sideComment, { questionId: "ship-tiles", pick: "Ship" }], followUps: [SIDE] }, false);

    expect(envelope).toMatchObject({ ok: true, data: { followUps: { sidecar: "recorded", filed: [{ questionId: SIDE, item: null }] } } });
    expect(await exists(inboxDir)).toBe(false);
  });

  it("writes no sidecar and files nothing for a follow-up mark on an untouched question", async () => {
    const { envelope } = await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), headSha: HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }], followUps: [SIDE] });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
    expect(envelope).not.toHaveProperty("data.followUps");
    expect(await exists(path.join(dir, ROUND, FOLLOW_UPS_FILE))).toBe(false);
    expect(await deposits()).toEqual([]);
  });

  it.each([
    ["the Ship decision", ["ship-tiles"], 'question "ship-tiles" is the Ship decision and cannot be a follow-up'],
    ["an unknown question", ["no-such"], 'no question "no-such" to mark follow-up'],
    ["a question twice", [SIDE, SIDE], `question "${SIDE}" is marked follow-up twice`],
  ])("refuses a follow-up mark on %s and writes nothing", async (_label, followUps, error) => {
    const { envelope, exitCode } = await ship(ROUND, HEAD, { followUps });

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error });
    expect(await exists(path.join(dir, ROUND, "feedback.json"))).toBe(false);
  });

  it("shows the sent round's follow-ups in its detail", async () => {
    await ship(ROUND, HEAD, { followUps: [SIDE] });

    expect(await getRound({ dir }, ROUND)).toMatchObject({ status: "sent", followUps: [SIDE] });
  });

  it("never asks a later round to address a follow-up comment, only the this-PR one", async () => {
    const answers = [sideComment, { questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is low." }];
    await submit({ id: ROUND, manifestSha256: await shaOf(ROUND), answers, followUps: [SIDE] });
    await reround();

    const detail = await getRound({ dir }, R2);

    expect(detail).toMatchObject({ priorFeedback: [{ round: 1, pick: "Don't ship", comment: "The stripe is low." }] });
  });

  it("leaves a later round nothing to address when round 1's only comment was a follow-up", async () => {
    await ship(ROUND, HEAD, { followUps: [SIDE] });
    await reround();

    expect(await getRound({ dir }, R2)).not.toHaveProperty("priorFeedback");
    const { envelope } = await submit({ id: R2, manifestSha256: await shaOf(R2), headSha: R2_HEAD, answers: [{ questionId: "ship-tiles", pick: "Ship" }] });
    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
  });
});
