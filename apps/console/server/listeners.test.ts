import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand } from "@titan-design/registry";
import type { AnswerOutcome, GateAnswerClient, GateAnswerRequest, Unreachable } from "./gate-answer.js";
import { createRoundListeners, type ListenerDeps, type RoundListeners } from "./listeners.js";
import type { ConsoleContext } from "./owner-guard.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { roundsSubmitCommands } from "./rounds-submit.js";
import type { ShepherdSource } from "./shepherd.js";

const ROUND = "orbit-retry-r1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MOVED_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const TREE = "fedcba9876543210fedcba9876543210fedcba98";
const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const PACKET = `${JSON.stringify({ headTree: TREE, images: [] })}\n`;

type Row = Awaited<ReturnType<ShepherdSource["list"]>>[number];

let root: string;
let dir: string;
let manifestSha256: string;
let rows: Row[];
let listCalls: number;
let posts: GateAnswerRequest[];
let reply: () => AnswerOutcome | Unreachable;
let listFails: boolean;
let postThrows: boolean;

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const answerFile = (): string => path.join(dir, ROUND, "answer.json");
const exists = (file: string) => stat(file).then(() => true, () => false);

function row(overrides: Record<string, unknown> = {}): Row {
  return {
    repo: "example/orbit-relay",
    pr: 12,
    branch: "orbit-retry",
    runId: "run-1",
    task: "orbit-retry",
    phase: "assisted",
    headSha: HEAD,
    phaseSince: "2026-10-01T00:00:00.000Z",
    nextAction: "owner: approve-merge",
    pendingGate: { gateId: "run-1/approve-merge:1", stepId: "approve-merge", since: "2026-10-01T00:00:00.000Z" },
    held: null,
    stalled: null,
    ...overrides,
  };
}

function deps(overrides: Partial<ListenerDeps> = {}): ListenerDeps {
  const shepherd = {
    async list() {
      listCalls += 1;
      if (listFails) throw new Error("factory down");
      return rows;
    },
  };
  const answer: GateAnswerClient = {
    async post(request) {
      posts.push(request);
      if (postThrows) throw new Error("boom");
      return reply();
    },
  };
  return { enabled: true, roundsDir: dir, shepherd, answer, now: () => new Date("2026-10-02T03:04:05.000Z"), ...overrides };
}

function ownerContext(): ConsoleContext {
  return { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };
}

function submit(listeners: RoundListeners, pick = "Ship") {
  const args = { id: ROUND, manifestSha256, headSha: HEAD, answers: [{ questionId: "ship-backoff", pick }] };
  return invokeCommand(roundsSubmitCommands({ dir }, undefined, listeners)["rounds.submit"], args, ownerContext());
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "listeners-"));
  dir = path.join(root, "rounds");
  await mkdir(dir);
  await cp(path.join(FIXTURE_ROUNDS.dir, ROUND), path.join(dir, ROUND), { recursive: true });
  await writeFile(path.join(dir, ROUND, "packet.json"), PACKET);
  manifestSha256 = sha256(await readFile(path.join(dir, ROUND, "round.json")));
  rows = [row()];
  listCalls = 0;
  posts = [];
  listFails = false;
  postThrows = false;
  reply = () => ({ status: "resolved", gateId: "run-1/approve-merge:1", choice: "merge" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the gate-answer listener after rounds.submit", () => {
  it("posts one request built from the round, the packet and the status row, and records the outcome", async () => {
    await submit(createRoundListeners(deps()));

    expect(posts).toEqual([
      { runId: "run-1", gateId: "run-1/approve-merge:1", headSha: HEAD, tree: TREE, packetSha: sha256(PACKET), roundId: ROUND, choice: "merge" },
    ]);
    expect(JSON.parse(await readFile(answerFile(), "utf8"))).toEqual({
      schema: "titan-console/gate-answer@1",
      at: "2026-10-02T03:04:05.000Z",
      request: { runId: "run-1", gateId: "run-1/approve-merge:1", headSha: HEAD, choice: "merge" },
      outcome: { status: "resolved", gateId: "run-1/approve-merge:1", choice: "merge" },
    });
    expect((await stat(answerFile())).mode & 0o777).toBe(0o600);
  });

  it("sends back when the owner picks the option that is not Ship", async () => {
    reply = () => ({ status: "resolved", gateId: "run-1/approve-merge:1", choice: "send-back" });

    await submit(createRoundListeners(deps()), "Don't ship");

    expect(posts.map((post) => post.choice)).toEqual(["send-back"]);
  });

  it("posts nothing and records moved when the status row's head is not the head the round showed", async () => {
    rows = [row({ headSha: MOVED_HEAD })];

    await submit(createRoundListeners(deps()));

    expect(posts).toEqual([]);
    expect(JSON.parse(await readFile(answerFile(), "utf8")).outcome).toEqual({ status: "moved", currentHead: MOVED_HEAD });
  });

  it("records gone without a post when the PR has no status row", async () => {
    rows = [row({ pr: 99 })];

    await submit(createRoundListeners(deps()));

    expect(posts).toEqual([]);
    expect(JSON.parse(await readFile(answerFile(), "utf8")).outcome).toEqual({ status: "gone", reason: "no shepherd row for example/orbit-relay#12" });
  });

  it("records gone without a post when the row has no pending approve-merge gate", async () => {
    rows = [row({ pendingGate: null })];

    await submit(createRoundListeners(deps()));

    expect(posts).toEqual([]);
    expect(JSON.parse(await readFile(answerFile(), "utf8")).outcome).toEqual({ status: "gone", reason: "no pending approve-merge gate" });
  });

  it("reads no status and posts nothing while the flag is off", async () => {
    await submit(createRoundListeners(deps({ enabled: false })));

    expect([listCalls, posts, await exists(answerFile())]).toEqual([0, [], false]);
  });

  it("does nothing for an already-submitted round", async () => {
    const listeners = createRoundListeners(deps());
    await submit(createRoundListeners(deps({ enabled: false })));

    await submit(listeners);

    expect([listCalls, posts]).toEqual([0, []]);
  });

  it("does nothing when packet.json is not beside the round", async () => {
    await rm(path.join(dir, ROUND, "packet.json"));

    await submit(createRoundListeners(deps()));

    expect([listCalls, posts, await exists(answerFile())]).toEqual([0, [], false]);
  });

  it("surfaces a moved response from the factory in answer.json", async () => {
    reply = () => ({ status: "moved", currentHead: MOVED_HEAD });

    await submit(createRoundListeners(deps()));

    expect(JSON.parse(await readFile(answerFile(), "utf8")).outcome).toEqual({ status: "moved", currentHead: MOVED_HEAD });
  });

  it("still returns submitted when the listener fails", async () => {
    postThrows = true;

    const { envelope } = await submit(createRoundListeners(deps()));

    expect(envelope).toMatchObject({ ok: true, data: { status: "submitted" } });
    expect(await exists(answerFile())).toBe(false);
  });
});

describe("the start-up sweep", () => {
  it("writes no answer.json while the factory is down, and answers once it is up", async () => {
    reply = () => ({ status: "unreachable", detail: "ECONNREFUSED" });
    const listeners = createRoundListeners(deps());
    await submit(listeners);
    expect(await exists(answerFile())).toBe(false);

    reply = () => ({ status: "resolved", gateId: "run-1/approve-merge:1", choice: "merge" });
    await listeners.sweep();

    expect(posts).toHaveLength(2);
    expect(JSON.parse(await readFile(answerFile(), "utf8")).outcome.status).toBe("resolved");
  });

  it("writes no answer.json while the status read fails", async () => {
    listFails = true;

    await submit(createRoundListeners(deps()));

    expect([posts, await exists(answerFile())]).toEqual([[], false]);
  });

  it("logs that an answered round whose round.json no longer parses was not relayed, and writes no answer.json", async () => {
    await submit(createRoundListeners(deps({ enabled: false })));
    await writeFile(path.join(dir, ROUND, "round.json"), "{ not json");
    const warnings: string[] = [];

    await createRoundListeners(deps({ logger: { warn: (_fields, message) => warnings.push(message) } })).sweep();

    expect(warnings).toEqual([expect.stringMatching(/^orbit-retry-r1: round\.json invalid; answer not relayed \(.+\)$/)]);
    expect([listCalls, posts, await exists(answerFile())]).toEqual([0, [], false]);
  });

  it("leaves a round that already has an answer.json alone", async () => {
    const listeners = createRoundListeners(deps());
    await submit(listeners);

    await listeners.sweep();

    expect(posts).toHaveLength(1);
  });

  it("does nothing while the flag is off", async () => {
    await submit(createRoundListeners(deps({ enabled: false })));

    await createRoundListeners(deps({ enabled: false })).sweep();

    expect([listCalls, posts]).toEqual([0, []]);
  });
});
