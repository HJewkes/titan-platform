import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { depositItemId, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import type { AnswerOutcome, BrokerAnswerer } from "./broker-answer.js";
import type { DecisionLog } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { ACTIONS_OFF, inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import type { InboxSources, WatchRow } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { CONFIRM_TTL_MS } from "./owner-tap.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const NEW_HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const ASKER = "test-asker";
const RUN_PLAIN = "11111111-0000-4000-8000-000000000001";
const RUN_OWNER = "22222222-0000-4000-8000-000000000002";
const PLAIN_ID = `gate:${RUN_PLAIN}/approve-merge`;
const OWNER_ID = `gate:${RUN_OWNER}/approve-merge`;
const RUN_G10 = "33333333-0000-4000-8000-000000000003";
const RUN_ADV = "44444444-0000-4000-8000-000000000004";
const G10_ID = `gate:${RUN_G10}/approve-merge`;
const ADV_ID = `gate:${RUN_ADV}/approve-merge`;
const OLD_HEAD = "0000000000aaaaaaaaaa0000000000aaaaaaaaaa";
const MSG = "msg-0007";
const CHAT_ID = `chat:${MSG}`;

const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const BEARER: RequestAuth = { credential: "bearer", issuedAt: null, peerLocal: false };

let dir: string;
let factory: FakeDaemon | undefined;
let items: OwnerItem[];
let rows: WatchRow[];
let clock: number;
let timelines: Record<number, unknown[]>;
let shepherd: ReturnType<typeof fakeShepherd>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-actions-"));
  items = [gate(RUN_PLAIN, "2026-10-10T03:00:00.000Z"), gate(RUN_OWNER, "2026-10-10T05:00:00.000Z"), chatAsk()];
  rows = [row(RUN_PLAIN, 1), row(RUN_OWNER, 2, "owner-asked: wait for me")];
  clock = Date.parse("2026-10-10T06:00:00.000Z");
  timelines = {};
  shepherd = fakeShepherd();
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

function gate(runId: string, openedAt: string): OwnerItem {
  const gateId = `${runId}/approve-merge`;
  return {
    id: `gate:${gateId}`,
    sources: [{ system: "hitl", ref: gateId }],
    kind: "approve",
    door: "one-way",
    summary: `Merge ${REPO} run ${runId.slice(0, 8)}?`,
    context: "",
    keys: [`gate:${gateId}`, `run:${runId}`],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt,
    status: "open",
  };
}

function chatAsk(): OwnerItem {
  return {
    id: CHAT_ID,
    sources: [{ system: "agent-chat", ref: MSG }],
    kind: "decide",
    door: "two-way",
    summary: "Which fixture name should the parser use?",
    context: "Two names fit; pick one.",
    options: [
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
    ],
    recommended: { optionId: "a", by: ASKER },
    keys: [],
    asker: ASKER,
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-10T04:00:00.000Z",
    status: "open",
  };
}

/** The broker as the console sees it: the first answer to an open question lands, any later one finds it closed. */
function spyBroker(first: AnswerOutcome = { status: "answered" }) {
  const answers: [string, string][] = [];
  const answerer: BrokerAnswerer = {
    answer: async (msgId, text) => {
      answers.push([msgId, text]);
      return answers.length === 1 ? first : { status: "closed", reason: `${msgId} is not an open item` };
    },
  };
  return { answerer, answers };
}

function row(runId: string, pr: number, held: string | null = null): WatchRow {
  return {
    repo: REPO,
    pr,
    branch: `feat/${pr}`,
    runId,
    task: "EX-1",
    phase: "awaiting-approval",
    headSha: HEAD,
    phaseSince: "2026-10-10T00:00:00.000Z",
    nextAction: "owner: resolve approve-merge",
    pendingGate: { gateId: `${runId}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
    held: held === null ? null : { reason: held },
    stalled: null,
  };
}

const verdict = (reviewer: string, value: "MERGE" | "FIX_FIRST", headSha: string, n = 1) => ({ kind: "verdict", stepId: `sh-await-verdict:${n}`, verdict: value, headSha, locator: null, reviewer });

/** `shepherd.release` as Shepherd answers it: refused at a head GitHub has moved past, and for a run whose hold is already lifted. */
function fakeShepherd(githubHead = HEAD) {
  const state = { githubHead, releases: [] as Record<string, unknown>[] };
  const release = (args: Record<string, unknown>) => {
    const ref = `${String(args.repo)}#${String(args.pr)}`;
    if (args.head !== state.githubHead) throw Object.assign(new Error(`${ref} is at ${state.githubHead}, not ${String(args.head)}, and is no clean merge-up Shepherd made of it`), { code: EXIT.DATAERR });
    if (state.releases.some((each) => each.pr === args.pr)) throw Object.assign(new Error(`${ref} is not held, so there is nothing to release`), { code: EXIT.DATAERR });
    state.releases.push(args);
    return { runId: rows.find((each) => each.pr === args.pr)!.runId, held: null };
  };
  return Object.assign(state, { release });
}

const actionsDir = () => path.join(dir, "owner-actions");

const recordShape = z.object({ action: z.object({ kind: z.string(), gateId: z.string().optional(), headSha: z.string() }) });

/** The factory route as the console sees it: it hashes the record it reads, and a resolve by that same hash reads back `already`. */
function spyFactory(githubHead = HEAD) {
  const posts: string[] = [];
  const settled = new Set<string>();
  const client: OwnerActionClient = {
    post: async (actionId): Promise<ActionOutcome> => {
      posts.push(actionId);
      const bytes = await readFile(path.join(actionsDir(), `${actionId}.json`)).catch(() => undefined);
      if (bytes === undefined) return { status: "gone", reason: `no action record ${actionId}` };
      const record = recordShape.parse(JSON.parse(bytes.toString("utf8")));
      if (record.action.headSha !== githubHead) return { status: "moved", currentHead: githubHead };
      const sha = createHash("sha256").update(bytes).digest("hex");
      const resolvedBy = [...settled][0];
      if (resolvedBy !== undefined) return resolvedBy === sha ? { status: "already", gateId: record.action.gateId ?? "" } : { status: "gone", reason: "the gate is resolved" };
      settled.add(sha);
      return record.action.kind === "owner-release" ? { status: "released", runId: RUN_OWNER, stillHeld: null } : { status: "resolved", gateId: record.action.gateId! };
    },
  };
  return { client, posts };
}

function spyLog() {
  const calls: Parameters<DecisionLog["record"]>[] = [];
  const log: DecisionLog = {
    record: async (...args) => {
      calls.push(args);
      return { ledger: "written", decisions: "not-configured" };
    },
  };
  return { log, calls };
}

async function sources(): Promise<InboxSources> {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command === "needs.list") return { items, gaps: [] };
    if (command === "shepherd.list") return rows;
    if (command === "shepherd.timeline") return { row: rows.find((each) => each.pr === args.pr), entries: timelines[Number(args.pr)] ?? [] };
    if (command === "shepherd.release") return shepherd.release(args);
    throw new Error(`no fixture for ${command}`);
  });
  return { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
}

const ownerContext = (auth: RequestAuth = SESSION, ownerWrites = true): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites });

interface Harness {
  prepare(itemId: string): Promise<JsonEnvelope<unknown>>;
  act(itemId: string, confirm: string, ctx?: ConsoleContext, text?: string): Promise<{ envelope: JsonEnvelope<unknown>; exitCode: number }>;
}

interface HarnessOptions {
  enabled?: boolean;
  decisionLog?: DecisionLog;
  answerer?: BrokerAnswerer;
}

async function harness(client: OwnerActionClient, options: HarnessOptions = {}): Promise<Harness> {
  const { decisionLog, answerer } = options;
  const commands = inboxActionCommands(await sources(), { enabled: options.enabled ?? true, actionsDir: actionsDir(), client, now: () => clock, ...(decisionLog && { decisionLog }), ...(answerer && { answerer }) });
  return {
    prepare: async (itemId) => (await invokeCommand(commands["inbox.prepare"], { itemId }, ownerContext())).envelope,
    act: (itemId, confirm, ctx = ownerContext(), text) => invokeCommand(commands["inbox.act"], { itemId, confirm, ...(text !== undefined && { text }) }, ctx),
  };
}

const readyEnvelope = z.object({ ok: z.literal(true), data: z.custom<Extract<PrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) });

const ready = (envelope: JsonEnvelope<unknown>) => readyEnvelope.parse(envelope).data;

const records = () => readdir(actionsDir()).catch(() => [] as string[]);

describe("inbox.prepare", () => {
  it("reads back the gate's repo, PR, title and head with a confirm valid five minutes", async () => {
    const { prepare } = await harness(spyFactory().client);

    const prepared = ready(await prepare(PLAIN_ID));

    expect(prepared.readBack).toEqual({ repo: REPO, pr: 1, title: `Merge ${REPO} run 11111111?`, headSha: HEAD, gateId: `${RUN_PLAIN}/approve-merge`, effect: `Approve the merge of ${REPO}#1 at 1234567` });
    expect(prepared.confirm).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(prepared.expiresAt) - clock).toBe(CONFIRM_TTL_MS);
  });

  it("reads back an owner-asked hold as its release, naming the hold", async () => {
    const { prepare } = await harness(spyFactory().client);

    const prepared = ready(await prepare(OWNER_ID));

    expect(prepared.action).toEqual({ kind: "owner-release", repo: REPO, pr: 2, headSha: HEAD });
    expect(prepared.readBack).toMatchObject({ hold: { class: "owner-asked", reason: "owner-asked: wait for me" }, effect: `Release the owner-asked hold on ${REPO}#2 at 1234567` });
  });

  it("gives a deposit item no action, even one carrying a live gate's key", async () => {
    await writeDeposit(path.join(dir, "deposits"), { depositId: "queue-1", asker: ASKER, kind: "do", door: "two-way", summary: "Resolve the plain gate", context: "", keys: [PLAIN_ID, `run:${RUN_PLAIN}`], command: "titan-factory shepherd waiting" });
    const { prepare } = await harness(spyFactory().client);

    const envelope = await prepare(depositItemId(ASKER, "queue-1"));

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", action: { kind: "terminal", command: "titan-factory shepherd waiting" } } });
  });
});

describe("inbox.act", () => {
  it("writes the action record once at 0600, posts its id and logs the owner-remote decision", async () => {
    const factorySpy = spyFactory();
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(factorySpy.client, { decisionLog: log });
    const { confirm } = ready(await prepare(PLAIN_ID));

    const { envelope } = await act(PLAIN_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { actionId: confirm, outcome: { status: "resolved", gateId: `${RUN_PLAIN}/approve-merge` }, message: "Merge approved" } });
    expect(factorySpy.posts).toEqual([confirm]);
    expect((await stat(path.join(actionsDir(), `${confirm}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(actionsDir())).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"))).toMatchObject({ itemId: PLAIN_ID, action: { kind: "resolve-gate", headSha: HEAD }, confirm, session: { issuedAt: 1_000 }, peer: "lan-remote" });
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.outcome.json`), "utf8"))).toMatchObject({ status: "resolved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ text: "merge", by: { class: "owner-remote", id: "titan-console", channel: "console:inbox" } });
  });

  it("refuses a bearer credential with 403 and writes no record", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare(PLAIN_ID));

    const { envelope, exitCode } = await act(PLAIN_ID, confirm, ownerContext(BEARER));

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope.ok).toBe(false);
    expect(await records()).toEqual([]);
    expect(factorySpy.posts).toEqual([]);
  });

  it("refuses a confirm read before the head moved, without posting to the factory", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare(PLAIN_ID));
    rows = [{ ...row(RUN_PLAIN, 1), headSha: NEW_HEAD }, rows[1]!];

    const { envelope, exitCode } = await act(PLAIN_ID, confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(factorySpy.posts).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("refuses a confirm over five minutes old before posting", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare(PLAIN_ID));
    clock += CONFIRM_TTL_MS;

    const { exitCode } = await act(PLAIN_ID, confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(factorySpy.posts).toEqual([]);
  });

  it("tells the owner the PR moved when GitHub's head is past the confirmed one, and logs nothing", async () => {
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory(NEW_HEAD).client, { decisionLog: log });
    const { confirm } = ready(await prepare(PLAIN_ID));

    const { envelope } = await act(PLAIN_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "moved", currentHead: NEW_HEAD }, message: "PR moved to abcdef1, read again" } });
    expect(calls).toEqual([]);
  });

  it("answers a replay of the same confirm as already, without rewriting the record or logging twice", async () => {
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory().client, { decisionLog: log });
    const { confirm } = ready(await prepare(PLAIN_ID));
    await act(PLAIN_ID, confirm);
    const first = await readFile(path.join(actionsDir(), `${confirm}.json`));
    items = items.filter((each) => each.id !== PLAIN_ID);
    clock += 1_000;

    const { envelope } = await act(PLAIN_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "already" }, message: "Already done by this confirmation" } });
    expect(await readFile(path.join(actionsDir(), `${confirm}.json`))).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("releases an owner-asked hold through the same route", async () => {
    const { prepare, act } = await harness(spyFactory().client);
    const { confirm } = ready(await prepare(OWNER_ID));

    const { envelope } = await act(OWNER_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "released", runId: RUN_OWNER, stillHeld: null }, message: "Hold released" } });
  });

  it("answers that inbox actions are off when the flag is off, and posts nothing", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client, { enabled: false });

    const prepared = await prepare(PLAIN_ID);
    const acted = await act(PLAIN_ID, "0".repeat(64));

    expect(prepared).toMatchObject({ ok: false, error: ACTIONS_OFF });
    expect(acted.envelope).toMatchObject({ ok: false, error: ACTIONS_OFF });
    expect(factorySpy.posts).toEqual([]);
  });
});

describe("inbox answer-chat", () => {
  it("reads back the question, its asker, options and recommendation", async () => {
    const { prepare } = await harness(spyFactory().client, { answerer: spyBroker().answerer });

    const prepared = ready(await prepare(CHAT_ID));

    expect(prepared.action).toEqual({ kind: "answer-chat", msgId: MSG });
    expect(prepared.readBack).toEqual({
      msgId: MSG,
      title: "Which fixture name should the parser use?",
      asker: ASKER,
      question: "Two names fit; pick one.",
      options: [
        { id: "a", label: "alpha" },
        { id: "b", label: "beta" },
      ],
      recommended: "a",
      effect: `Answer ${ASKER}'s question; the broker records it as yours`,
    });
  });

  it("offers no action when no broker answerer is wired", async () => {
    const { prepare } = await harness(spyFactory().client);

    expect(await prepare(CHAT_ID)).toMatchObject({ ok: true, data: { status: "no-action", action: { kind: "answer-chat" } } });
  });

  it("sends the owner's text to the broker, keeps it in the record and logs it as the answer", async () => {
    const broker = spyBroker();
    const factorySpy = spyFactory();
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(factorySpy.client, { answerer: broker.answerer, decisionLog: log });
    const { confirm } = ready(await prepare(CHAT_ID));

    const { envelope } = await act(CHAT_ID, confirm, undefined, "  alpha  ");

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "answered" }, message: "Answer sent" } });
    expect(broker.answers).toEqual([[MSG, "alpha"]]);
    expect(factorySpy.posts).toEqual([]);
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"))).toMatchObject({ itemId: CHAT_ID, action: { kind: "answer-chat", msgId: MSG }, text: "alpha" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ text: "alpha", by: { class: "owner-remote", id: "titan-console", channel: "console:inbox" } });
  });

  it("refuses an answer with no text before writing or sending anything", async () => {
    const broker = spyBroker();
    const { prepare, act } = await harness(spyFactory().client, { answerer: broker.answerer });
    const { confirm } = ready(await prepare(CHAT_ID));

    const { envelope, exitCode } = await act(CHAT_ID, confirm, undefined, "   ");

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: "an answer needs text" });
    expect(broker.answers).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("refuses text on a gate tap rather than dropping it", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client, { answerer: spyBroker().answerer });
    const { confirm } = ready(await prepare(PLAIN_ID));

    const { exitCode } = await act(PLAIN_ID, confirm, undefined, "merge");

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(factorySpy.posts).toEqual([]);
  });

  it("tells the owner the question closed when another answer won the race, and logs nothing", async () => {
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory().client, { answerer: spyBroker({ status: "closed", reason: `${MSG} is not an open item` }).answerer, decisionLog: log });
    const { confirm } = ready(await prepare(CHAT_ID));

    const { envelope } = await act(CHAT_ID, confirm, undefined, "alpha");

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "closed" }, message: expect.stringMatching(/^Not sent; the question is closed/) } });
    expect(calls).toEqual([]);
  });

  it("leaves a broker-down answer unsettled, so the retry sends the words first written", async () => {
    const broker = spyBroker({ status: "unreachable", detail: "connect ECONNREFUSED" });
    const { prepare, act } = await harness(spyFactory().client, { answerer: broker.answerer });
    const { confirm } = ready(await prepare(CHAT_ID));

    const down = await act(CHAT_ID, confirm, undefined, "alpha");
    const afterDown = await records();
    await act(CHAT_ID, confirm, undefined, "beta");

    expect(down.envelope).toMatchObject({ ok: true, data: { outcome: { status: "unreachable" } } });
    expect(afterDown).toEqual([`${confirm}.json`]);
    expect(broker.answers).toEqual([
      [MSG, "alpha"],
      [MSG, "alpha"],
    ]);
  });
});

describe("inbox g10 hold release", () => {
  beforeEach(() => {
    items = [...items, gate(RUN_G10, "2026-10-10T05:30:00.000Z"), gate(RUN_ADV, "2026-10-10T05:40:00.000Z")];
    rows = [...rows, row(RUN_G10, 3, "g10-review: awaiting an opus review"), row(RUN_ADV, 4, "g10-adversary: awaiting two reviews")];
  });

  it("reads back the verdicts at the live head and releases through Shepherd as the console's owner-remote", async () => {
    timelines[3] = [verdict("reviewer-a", "FIX_FIRST", OLD_HEAD, 1), verdict("reviewer-a", "MERGE", HEAD, 2)];
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory().client, { decisionLog: log });
    const prepared = ready(await prepare(G10_ID));

    const { envelope } = await act(G10_ID, prepared.confirm);

    expect(prepared.action).toEqual({ kind: "hold-release", repo: REPO, pr: 3, headSha: HEAD, holdClass: "g10-review" });
    expect(prepared.readBack).toMatchObject({
      verdicts: [
        { reviewer: "reviewer-a", verdict: "FIX_FIRST", headSha: OLD_HEAD, atHead: false },
        { reviewer: "reviewer-a", verdict: "MERGE", headSha: HEAD, atHead: true },
      ],
      mergesAtHead: 1,
      mergesNeeded: 1,
      confirmLabel: "Release hold",
      effect: `Release the g10-review hold on ${REPO}#3 at 1234567; the reviewer's MERGE stands at this head`,
    });
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "released", runId: RUN_G10, stillHeld: null }, message: "Hold released" } });
    expect(shepherd.releases).toEqual([{ repo: REPO, pr: 3, head: HEAD, holdClass: "g10-review", actor: `owner-remote:titan-console action:${prepared.confirm}` }]);
    expect(calls[0]![1]).toMatchObject({ text: "release", by: { class: "owner-remote" } });
  });

  it("still offers the release with no MERGE at the live head, and says so on the confirm", async () => {
    timelines[3] = [verdict("reviewer-a", "MERGE", OLD_HEAD)];
    const { prepare, act } = await harness(spyFactory().client);
    const prepared = ready(await prepare(G10_ID));

    const { envelope } = await act(G10_ID, prepared.confirm);

    expect(prepared.readBack).toMatchObject({ mergesAtHead: 0, confirmLabel: "Release without a MERGE", effect: expect.stringMatching(/no reviewer MERGE is recorded at this head$/) });
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "released" } } });
  });

  it("counts a g10-adversary hold with one MERGE, or two from one reviewer, as short of both", async () => {
    timelines[4] = [verdict("reviewer-a", "MERGE", HEAD, 1), verdict("reviewer-a", "MERGE", HEAD, 2)];
    const { prepare } = await harness(spyFactory().client);

    const prepared = ready(await prepare(ADV_ID));

    expect(prepared.readBack).toMatchObject({ mergesAtHead: 1, mergesNeeded: 2, confirmLabel: "Release without both MERGEs", effect: expect.stringMatching(/only 1 of the 2 MERGEs it needs/) });
  });

  it("reads a g10-adversary hold with two reviewers' MERGEs at the head as a plain release", async () => {
    timelines[4] = [verdict("reviewer-a", "MERGE", HEAD, 1), verdict("reviewer-b", "MERGE", HEAD, 2)];
    const { prepare } = await harness(spyFactory().client);

    const prepared = ready(await prepare(ADV_ID));

    expect(prepared.readBack).toMatchObject({ mergesAtHead: 2, confirmLabel: "Release hold", effect: expect.stringMatching(/both MERGEs stand at this head$/) });
  });

  it("tells the owner the PR moved when Shepherd refuses the confirmed head, and logs nothing", async () => {
    shepherd.githubHead = NEW_HEAD;
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory().client, { decisionLog: log });
    const { confirm } = ready(await prepare(G10_ID));

    const { envelope } = await act(G10_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "moved", currentHead: NEW_HEAD }, message: "PR moved to abcdef1, read again" } });
    expect(shepherd.releases).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("answers a replay as already without asking Shepherd to release again", async () => {
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spyFactory().client, { decisionLog: log });
    const { confirm } = ready(await prepare(G10_ID));
    await act(G10_ID, confirm);

    const { envelope } = await act(G10_ID, confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "already", runId: RUN_G10 }, message: "Already done by this confirmation" } });
    expect(shepherd.releases).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("refuses a confirm read before a verdict landed, without releasing", async () => {
    const { prepare, act } = await harness(spyFactory().client);
    const { confirm } = ready(await prepare(G10_ID));
    timelines[3] = [verdict("reviewer-a", "MERGE", HEAD)];

    const { envelope, exitCode } = await act(G10_ID, confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(shepherd.releases).toEqual([]);
  });

  it("offers no action for a hold of a class only its seat releases", async () => {
    rows = [...rows.slice(0, 2), row(RUN_G10, 3, "stalled: EX-2 the run stopped")];
    const { prepare } = await harness(spyFactory().client);

    expect(await prepare(G10_ID)).toMatchObject({ ok: true, data: { status: "no-action", reason: "a stalled hold is released by its seat, not from the inbox" } });
  });
});
