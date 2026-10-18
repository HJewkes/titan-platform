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
import type { DecisionLog } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { ACTIONS_OFF, CONFIRM_TTL_MS, inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import type { InboxSources, WatchRow } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
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

const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const BEARER: RequestAuth = { credential: "bearer", issuedAt: null, peerLocal: false };

let dir: string;
let factory: FakeDaemon | undefined;
let items: OwnerItem[];
let rows: WatchRow[];
let clock: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-actions-"));
  items = [gate(RUN_PLAIN, "2026-10-10T03:00:00.000Z"), gate(RUN_OWNER, "2026-10-10T05:00:00.000Z")];
  rows = [row(RUN_PLAIN, 1), row(RUN_OWNER, 2, "owner-asked: wait for me")];
  clock = Date.parse("2026-10-10T06:00:00.000Z");
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
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command === "needs.list") return { items, gaps: [] };
    if (command === "shepherd.list") return rows;
    throw new Error(`no fixture for ${command}`);
  });
  return { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
}

const ownerContext = (auth: RequestAuth = SESSION, ownerWrites = true): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites });

interface Harness {
  prepare(itemId: string): Promise<JsonEnvelope<unknown>>;
  act(itemId: string, confirm: string, ctx?: ConsoleContext): Promise<{ envelope: JsonEnvelope<unknown>; exitCode: number }>;
}

async function harness(client: OwnerActionClient, options: { enabled?: boolean; decisionLog?: DecisionLog } = {}): Promise<Harness> {
  const commands = inboxActionCommands(await sources(), { enabled: options.enabled ?? true, actionsDir: actionsDir(), client, now: () => clock, ...(options.decisionLog && { decisionLog: options.decisionLog }) });
  return {
    prepare: async (itemId) => (await invokeCommand(commands["inbox.prepare"], { itemId }, ownerContext())).envelope,
    act: (itemId, confirm, ctx = ownerContext()) => invokeCommand(commands["inbox.act"], { itemId, confirm }, ctx),
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
