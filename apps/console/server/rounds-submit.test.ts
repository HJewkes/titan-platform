import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { ANSWERS_FILE, createDecisionLog, type DecisionLog, type DecisionLogResult } from "./decision-log.js";
import type { RoundListeners } from "./listeners.js";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS, PANELS_HEAD, TILES_HEAD, twoPrRound } from "./round-fixtures.js";
import { withdrawRound } from "./round-withdraw.js";
import { BLIND_AB_REFUSED } from "./round-schema.js";
import { FeedbackDocument } from "./round2-adapter.js";
import { ADDRESSED_FILE, MAX_FEEDBACK_BYTES, roundsSubmitCommands } from "./rounds-submit.js";
import { getRound, listRounds } from "./rounds.js";

const ROUND = "orbit-retry-r1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

let root: string;
let dir: string;
let manifestSha256: string;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function ownerContext(ownerWrites = true): ConsoleContext {
  return { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites };
}

function submit(args: Record<string, unknown>, ctx = ownerContext(), decisionLog?: DecisionLog, listeners?: RoundListeners) {
  return invokeCommand(roundsSubmitCommands({ dir }, decisionLog, listeners)["rounds.submit"], args, ctx);
}

function spyLog(result: DecisionLogResult = { ledger: "written", decisions: "not-a-decision" }) {
  const calls: Parameters<DecisionLog["record"]>[] = [];
  const log: DecisionLog = {
    record: async (...args) => {
      calls.push(args);
      return result;
    },
  };
  return { log, calls };
}

function shipArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ROUND, manifestSha256, headSha: HEAD, answers: [{ questionId: "ship-backoff", pick: "Ship" }], ...overrides };
}

const feedbackOf = (id = ROUND) => path.join(dir, id, "feedback.json");
const exists = (file: string) => stat(file).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rounds-submit-"));
  dir = path.join(root, "rounds");
  await mkdir(dir);
  await cp(path.join(FIXTURE_ROUNDS.dir, ROUND), path.join(dir, ROUND), { recursive: true });
  manifestSha256 = sha256(await readFile(path.join(dir, ROUND, "round.json")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("rounds.submit", () => {
  it("writes one feedback@1 file at mode 0600 and returns its path, sha256 and the shipped head", async () => {
    const { envelope } = await submit(shipArgs());

    const bytes = await readFile(feedbackOf());
    expect(envelope).toEqual({ ok: true, data: { status: "submitted", path: feedbackOf(), sha256: sha256(bytes), headSha: HEAD } });
    expect((await stat(feedbackOf())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({
      schema: "titan-review/feedback@1",
      unit: "orbit-retry",
      round: 1,
      manifestSha256,
      submittedAt: expect.any(String),
      answers: [{ questionId: "ship-backoff", pick: "Ship", recommendationSeen: true }],
      variants: [],
      general: "",
    });
  });

  it("is refused without the owner-write class and writes nothing", async () => {
    const { envelope, exitCode } = await submit(shipArgs(), ownerContext(false));

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope).toMatchObject({ ok: false, error: "owner-write command refused: owner writes are off" });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it.each([
    ["a parent segment", ".."],
    ["a path through the parent", `../rounds/${ROUND}`],
    ["an absolute path", path.sep + ROUND],
    ["an unknown id", "no-such-round"],
    ["a symlinked round dir", "linked-r1"],
  ])("resolves only a real round dir inside the rounds dir: refuses %s as not found", async (_label, id) => {
    await symlink(path.join(dir, ROUND), path.join(dir, "linked-r1"));

    const { envelope, exitCode } = await submit(shipArgs({ id }));

    expect(exitCode).toBe(EXIT.NOINPUT);
    expect(envelope).toMatchObject({ ok: false, error: `No round named "${id}"` });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("writes once: a second submit is already-submitted and leaves the first file's bytes", async () => {
    await submit(shipArgs());
    const first = await readFile(feedbackOf());

    const { envelope } = await submit(shipArgs({ answers: [{ questionId: "ship-backoff", pick: "Don't ship" }], general: "second" }));

    expect(envelope).toEqual({ ok: true, data: { status: "already-submitted" } });
    expect(await readFile(feedbackOf())).toEqual(first);
  });

  it("never writes through a symlink planted at feedback.json", async () => {
    const target = path.join(root, "elsewhere.json");
    await writeFile(target, "untouched");
    await symlink(target, feedbackOf());

    const { envelope } = await submit(shipArgs());

    expect(envelope).toEqual({ ok: true, data: { status: "already-submitted" } });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });

  it.each([
    ["a manifest sha256 that is not the file on disk", { manifestSha256: "f".repeat(64) }, "round.json has changed since it was shown; reload the round"],
    ["a Ship with no head sha", { headSha: undefined }, "a Ship answer must carry the head sha its question names"],
    ["a Ship naming another head sha", { headSha: "f".repeat(40) }, 'question "ship-backoff" names a different head sha'],
  ])("binds to what was shown: refuses %s", async (_label, overrides, error) => {
    const { envelope, exitCode } = await submit(shipArgs(overrides));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("needs no head sha when the answer does not ship", async () => {
    const { envelope } = await submit(shipArgs({ headSha: undefined, answers: [{ questionId: "ship-backoff", pick: "Don't ship" }] }));

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: null } });
  });

  it.each([
    ["an unknown question id", [{ questionId: "ship-other", pick: "Ship" }], 'no question "ship-other" in this round'],
    ["a question answered twice", [{ questionId: "ship-backoff", pick: "Ship" }, { questionId: "ship-backoff", pick: "Ship" }], 'question "ship-backoff" is answered twice'],
    ["a pick outside the options", [{ questionId: "ship-backoff", pick: "Merge it" }], 'question "ship-backoff": "Merge it" is not one of its options'],
    ["a field the question kind does not take", [{ questionId: "ship-backoff", value: 3 }], 'question "ship-backoff": value does not answer a pick-one question'],
  ])("validates the answers: refuses %s", async (_label, answers, error) => {
    const { envelope, exitCode } = await submit(shipArgs({ answers }));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("refuses an answer field outside the feedback@1 shape", async () => {
    const { exitCode } = await submit(shipArgs({ answers: [{ questionId: "ship-backoff", pick: "Ship", approvedBy: "agent" }] }));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("answers a Ship round, whose variants are the PR's images, but refuses a design round without frames.json", async () => {
    for (const id of ["ship-tile-r1", "lantern-cards-r1"]) await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
    const shaOf = async (id: string) => sha256(await readFile(path.join(dir, id, "round.json")));
    const shipTiles = { questionId: "ship-tiles", pick: "Ship" };

    const ship = await submit({ id: "ship-tile-r1", manifestSha256: await shaOf("ship-tile-r1"), headSha: "89abcdef0123456789abcdef0123456789abcdef", answers: [shipTiles] });
    const design = await submit({ id: "lantern-cards-r1", manifestSha256: await shaOf("lantern-cards-r1"), answers: [] });

    expect(ship.envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: "89abcdef0123456789abcdef0123456789abcdef" } });
    expect(design.envelope).toMatchObject({ ok: false, error: "a design round without frames/frames.json is answered in the review harness" });
    expect(await exists(feedbackOf("lantern-cards-r1"))).toBe(false);
  });

  it("saves a design round's answers when its frames.json is valid", async () => {
    const id = "beacon-states-r1";
    await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
    const manifestSha256 = sha256(await readFile(path.join(dir, id, "round.json")));
    const answers = [{ questionId: "beacon-fill-pick", pick: "Ring" }, { questionId: "beacon-notes", text: "Keep the halo." }];

    const { envelope } = await submit({ id, manifestSha256, answers });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: null } });
    expect(JSON.parse(await readFile(feedbackOf(id), "utf8"))).toMatchObject({ unit: "beacon-dot", answers });
  });

  it("refuses a design round whose frames.json is not a frames@1 index", async () => {
    const id = "beacon-states-r1";
    await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
    await writeFile(path.join(dir, id, "frames", "frames.json"), "not json");

    const { envelope } = await submit({ id, manifestSha256: sha256(await readFile(path.join(dir, id, "round.json"))), answers: [] });

    expect(envelope).toMatchObject({ ok: false, error: "a design round without frames/frames.json is answered in the review harness" });
    expect(await exists(feedbackOf(id))).toBe(false);
  });

  it("writes the side answers a Ship round carries, with the Ship pick, to one feedback.json", async () => {
    const id = "ship-tile-r1";
    await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
    const file = path.join(dir, id, "round.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.questions.unshift(
      { id: "side-many", kind: "pick-many", prompt: "Which tiles need a second look?", options: ["Light", "Dark"] },
      { id: "side-scale", kind: "scale", prompt: "How clear is the stripe?", min: 1, max: 5 },
      { id: "side-text", kind: "text", prompt: "Anything else?" },
    );
    manifest.sections.find((section: { id: string }) => section.id === "side").questionIds.push("side-many", "side-scale", "side-text");
    await writeFile(file, JSON.stringify(manifest));
    const answers = [
      { questionId: "badge-follow-up", pick: "No" },
      { questionId: "side-many", picks: ["Light"] },
      { questionId: "side-scale", value: 4 },
      { questionId: "side-text", text: "Fine." },
      { questionId: "ship-tiles", pick: "Ship" },
    ];

    const { envelope } = await submit({ id, manifestSha256: sha256(await readFile(file)), headSha: "89abcdef0123456789abcdef0123456789abcdef", answers });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
    const written = FeedbackDocument.parse(JSON.parse(await readFile(feedbackOf(id), "utf8")));
    expect(written.answers.map((answer) => answer.questionId)).toEqual(["badge-follow-up", "side-many", "side-scale", "side-text", "ship-tiles"]);
  });

  it("answers a TD-920 CI-packet round, which only review-schema 0.3 accepts, with Ship at its bound head", async () => {
    const id = "td920-packet-r1";
    const head = "a1".repeat(20);
    await cp(path.join(FIXTURE_ROUNDS.dir, id), path.join(dir, id), { recursive: true });
    const roundSha = sha256(await readFile(path.join(dir, id, "round.json")));

    const { envelope } = await submit({ id, manifestSha256: roundSha, headSha: head, answers: [{ questionId: "ship", pick: "Ship" }] });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: head } });
  });

  it("refuses a round.json the lister calls invalid, such as one with an unknown top-level key, and writes nothing", async () => {
    const round = path.join(dir, ROUND, "round.json");
    const bytes = Buffer.from((await readFile(round, "utf8")).replace(/^\{/, '{"approvedBy": "agent", '));
    await writeFile(round, bytes);

    const { envelope, exitCode } = await submit(shipArgs({ manifestSha256: sha256(bytes) }));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringContaining("round.json is not a valid round: ") });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("refuses a blind-ab round, which review-schema 0.3 accepts, and writes nothing", async () => {
    const id = "blind-r1";
    const round = JSON.parse(await readFile(path.join(FIXTURE_ROUNDS.dir, "td920-packet-r1", "round.json"), "utf8"));
    const takes = [{ engine: "engine-alpha", src: "audio/a.wav" }, { engine: "engine-beta", src: "audio/b.wav" }];
    round.questions.push({ id: "listen", kind: "blind-ab", prompt: "Which take reads better?", pairs: [{ id: "line-1", transcript: "Welcome back.", takes }] });
    round.sections = round.sections.map((section: { id: string }) => (section.id === "side" ? { ...section, questionIds: ["bundle", "listen"] } : section));
    const bytes = Buffer.from(JSON.stringify(round));
    await mkdir(path.join(dir, id));
    await writeFile(path.join(dir, id, "round.json"), bytes);

    const { envelope, exitCode } = await submit({ id, manifestSha256: sha256(bytes), answers: [] });

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringContaining(BLIND_AB_REFUSED) });
    expect(await exists(feedbackOf(id))).toBe(false);
  });

  it("refuses feedback over the size cap", async () => {
    const { envelope, exitCode } = await submit(shipArgs({ answers: [{ questionId: "ship-backoff", pick: "Don't ship" }], general: "x".repeat(MAX_FEEDBACK_BYTES) }));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: `the feedback is over ${MAX_FEEDBACK_BYTES} bytes` });
    expect(await exists(feedbackOf())).toBe(false);
  });

  it("records the answered question in the decision log after the file is written", async () => {
    const stateDir = path.join(root, "state");
    const decisionLog = createDecisionLog({ stateDir, decisionsFile: null, humanOnly: async () => ({ known: true, initiatives: new Set<string>() }) });

    const { envelope } = await submit(shipArgs(), ownerContext(), decisionLog);

    const { submittedAt } = FeedbackDocument.parse(JSON.parse(await readFile(feedbackOf(), "utf8")));
    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", log: [{ questionId: "ship-backoff", ledger: "written", decisions: "not-a-decision" }] } });
    const rows = (await readFile(path.join(stateDir, ANSWERS_FILE), "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(rows).toEqual([
      expect.objectContaining({ key: `round:${ROUND}:ship-backoff:${submittedAt}`, question: "Ship the capped backoff?", answer: "Ship", recommended: "Ship", decisions: null }),
    ]);
  });

  it("runs the decision log and then the round listener for a submitted round", async () => {
    const order: string[] = [];
    const { log } = spyLog();
    const recording: DecisionLog = { record: async (...args) => (order.push("log"), log.record(...args)) };
    const listeners: RoundListeners = {
      afterRoundSubmit: async (id, result) => void order.push(`listener:${id}:${result.status}`),
      sweep: async () => undefined,
    };

    const { envelope } = await submit(shipArgs(), ownerContext(), recording, listeners);

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", log: [{ questionId: "ship-backoff" }] } });
    expect(order).toEqual(["log", `listener:${ROUND}:submitted`]);
  });

  it("records nothing for a comment-only answer", async () => {
    const { log, calls } = spyLog();

    const { envelope } = await submit(shipArgs({ headSha: undefined, answers: [{ questionId: "ship-backoff", comment: "Looking." }] }), ownerContext(), log);

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", log: [] } });
    expect(calls).toEqual([]);
  });

  it.each([
    ["a refused submit", shipArgs({ manifestSha256: "f".repeat(64) })],
    ["an owner-write refusal", shipArgs(), ownerContext(false)],
  ] as const)("records nothing for %s", async (_label, args, ctx = ownerContext()) => {
    const { log, calls } = spyLog();

    await submit(args, ctx, log);

    expect(calls).toEqual([]);
  });

  it("records nothing when the round was already submitted", async () => {
    await submit(shipArgs());
    const { log, calls } = spyLog();

    const { envelope } = await submit(shipArgs(), ownerContext(), log);

    expect(envelope).toEqual({ ok: true, data: { status: "already-submitted" } });
    expect(calls).toEqual([]);
  });

  it("keeps the submit when the decision log fails, and says so in log", async () => {
    const { log, calls } = spyLog({ ledger: "failed", decisions: "not-a-decision", reason: "ledger write failed" });

    const { envelope } = await submit(shipArgs(), ownerContext(), log);

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", log: [{ ledger: "failed", reason: "ledger write failed" }] } });
    expect(await exists(feedbackOf())).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses a withdrawn round before writing, so neither the decision log nor a listener runs", async () => {
    await withdrawRound(dir, ROUND, "closed");
    const { log, calls } = spyLog();
    const heard: string[] = [];
    const listeners: RoundListeners = { afterRoundSubmit: async (id) => void heard.push(id), sweep: async () => undefined };

    const { envelope, exitCode } = await submit(shipArgs(), ownerContext(), log, listeners);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/^refused: withdrawn/) });
    expect(await exists(feedbackOf())).toBe(false);
    expect(calls).toEqual([]);
    expect(heard).toEqual([]);
  });
});

/** orbit-retry-r1 as a round published before merge bindings were required: "Merge #12" offered, nothing bound. */
async function publishUnboundRound(): Promise<string> {
  const file = path.join(dir, ROUND, "round.json");
  const round = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")));
  const questions = z.array(z.record(z.string(), z.unknown())).parse(round.questions);
  const unbound = questions.map(({ merge: _merge, page: _page, recommendation: _recommendation, ...question }) => ({
    ...question,
    options: ["Merge #12 at this head", "Hold"],
  }));
  const bytes = Buffer.from(JSON.stringify({ ...round, questions: unbound }));
  await writeFile(file, bytes);
  return sha256(bytes);
}

describe("a round published before merge bindings were required", () => {
  it("a published unbound round still lists and accepts a submit", async () => {
    const unboundSha = await publishUnboundRound();

    const { rounds } = await listRounds({ dir });
    const { envelope } = await submit({ id: ROUND, manifestSha256: unboundSha, answers: [{ questionId: "ship-backoff", pick: "Merge #12 at this head" }] });

    expect(rounds).toEqual([expect.objectContaining({ id: ROUND, valid: true, ship: false, unbound: true })]);
    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", path: feedbackOf() } });
  });
});

const R2 = "orbit-retry-r2";
const R2_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

/** The td769 shape: round 1 answered Don't ship with a note, then round 2 asks to Ship a new head. */
async function sendBackThenReround(): Promise<string> {
  await submit({ id: ROUND, manifestSha256, answers: [{ questionId: "ship-backoff", pick: "Don't ship", comment: "Cap the jitter too." }] });
  const round = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path.join(dir, ROUND, "round.json"), "utf8")));
  const questions = z.array(z.record(z.string(), z.unknown())).parse(round.questions);
  const reround = questions.map((question) => ({ ...question, merge: { repo: "example/orbit-relay", pr: 12, headSha: R2_HEAD, ship: ["Ship"] } }));
  const bytes = Buffer.from(JSON.stringify({ ...round, round: 2, questions: reround }));
  await mkdir(path.join(dir, R2));
  await writeFile(path.join(dir, R2, "round.json"), bytes);
  return sha256(bytes);
}

const shipR2 = (r2Sha: string, overrides: Record<string, unknown> = {}) =>
  submit({ id: R2, manifestSha256: r2Sha, headSha: R2_HEAD, answers: [{ questionId: "ship-backoff", pick: "Ship" }], ...overrides });

describe("a Ship round after earlier feedback (TP-3741)", () => {
  it("carries round 1's Don't ship and its note into round 2's detail", async () => {
    await sendBackThenReround();

    const detail = await getRound({ dir }, R2);

    expect(detail).toMatchObject({ valid: true, priorFeedback: [{ round: 1, pick: "Don't ship", comment: "Cap the jitter too.", submittedAt: expect.any(String) }] });
  });

  it("refuses Ship until round 1 is ticked Addressed, and writes nothing", async () => {
    const r2Sha = await sendBackThenReround();

    const { envelope, exitCode } = await shipR2(r2Sha);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: "Ship refused: your feedback from round 1 is not ticked Addressed" });
    expect(await exists(feedbackOf(R2))).toBe(false);
  });

  it("accepts Ship with round 1 ticked, and keeps the tick in the addressed.json sidecar", async () => {
    const r2Sha = await sendBackThenReround();

    const { envelope } = await shipR2(r2Sha, { addressed: [1] });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: R2_HEAD, addressed: "recorded" } });
    expect(JSON.parse(await readFile(path.join(dir, R2, ADDRESSED_FILE), "utf8"))).toEqual({ schema: "titan-console/addressed@1", rounds: [1], at: expect.any(String) });
    expect(await getRound({ dir }, R2)).not.toHaveProperty("priorFeedback");
  });

  it("still takes a Send back while round 1 is unticked", async () => {
    const r2Sha = await sendBackThenReround();

    const { envelope } = await shipR2(r2Sha, { answers: [{ questionId: "ship-backoff", pick: "Don't ship" }] });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
  });

  it.each([
    ["a comment", { answers: [{ questionId: "ship-backoff", pick: "Ship", comment: "Rename the constant." }] }, 'you left a comment on "Ship the capped backoff?"'],
    ["round feedback", { general: "Rename the constant." }, "you left feedback on this round"],
  ])("refuses a Ship that carries %s", async (_label, overrides, reason) => {
    const { envelope, exitCode } = await submit(shipArgs(overrides));

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: `Ship refused: ${reason}` });
    expect(await exists(feedbackOf())).toBe(false);
  });
});

describe("a round with two PRs (TP-3329)", () => {
  const TWO = "tiles-and-panels-r1";
  let twoSha: string;

  beforeEach(async () => {
    await cp(path.join(FIXTURE_ROUNDS.dir, "ship-tile-r1"), path.join(dir, TWO), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(twoPrRound()));
    await writeFile(path.join(dir, TWO, "round.json"), bytes);
    twoSha = sha256(bytes);
  });

  const submitTwo = (overrides: Record<string, unknown>) => submit({ id: TWO, manifestSha256: twoSha, answers: [], ...overrides });

  it("ships both PRs, each at its own head, and records every answer in one feedback.json", async () => {
    const answers = [{ questionId: "stripe-colour", pick: "Keep" }, { questionId: "ship-tiles", pick: "Ship" }, { questionId: "ship-panels", pick: "Ship" }];

    const { envelope } = await submitTwo({ answers, heads: { "ship-tiles": TILES_HEAD, "ship-panels": PANELS_HEAD } });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: null, heads: { "ship-tiles": TILES_HEAD, "ship-panels": PANELS_HEAD } } });
    const written = FeedbackDocument.parse(JSON.parse(await readFile(feedbackOf(TWO), "utf8")));
    expect(written.answers).toEqual(answers);
  });

  it("ships one PR and sends the other back, its note blocking only its own Ship", async () => {
    const answers = [{ questionId: "ship-tiles", pick: "Don't ship", comment: "Lower the stripe." }, { questionId: "ship-panels", pick: "Ship" }];

    const { envelope } = await submitTwo({ answers, heads: { "ship-panels": PANELS_HEAD } });

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: PANELS_HEAD } });
  });

  it.each([
    ["a shipped PR with no head", { "ship-tiles": TILES_HEAD }, 'question "ship-panels" ships without its head sha in heads'],
    ["a head from the other PR", { "ship-tiles": TILES_HEAD, "ship-panels": TILES_HEAD }, 'question "ship-panels" names a different head sha'],
    ["a head for a PR that is not shipped", { "ship-tiles": TILES_HEAD, "ship-panels": PANELS_HEAD, "stripe-colour": TILES_HEAD }, 'heads names "stripe-colour", which no Ship answer ships'],
  ])("refuses %s and writes nothing", async (_, heads, error) => {
    const { envelope, exitCode } = await submitTwo({ answers: [{ questionId: "ship-tiles", pick: "Ship" }, { questionId: "ship-panels", pick: "Ship" }], heads });

    expect({ envelope, exitCode }).toEqual({ envelope: { ok: false, error, code: EXIT.DATAERR }, exitCode: EXIT.DATAERR });
    expect(await exists(feedbackOf(TWO))).toBe(false);
  });

  it("refuses a Ship whose own side question carries a comment, but not the other PR's", async () => {
    const answers = [{ questionId: "stripe-colour", pick: "Keep", comment: "Check the contrast." }, { questionId: "ship-tiles", pick: "Ship" }, { questionId: "ship-panels", pick: "Ship" }];

    const both = await submitTwo({ answers, heads: { "ship-tiles": TILES_HEAD, "ship-panels": PANELS_HEAD } });
    const panelsOnly = await submitTwo({ answers: [answers[0], { questionId: "ship-tiles", pick: "Don't ship" }, answers[2]], heads: { "ship-panels": PANELS_HEAD } });

    expect(both.envelope).toMatchObject({ ok: false, error: 'Ship refused: you left a comment on "Keep the stripe colour?"' });
    expect(panelsOnly.envelope).toMatchObject({ ok: true, data: { status: "submitted", headSha: PANELS_HEAD } });
  });
});
