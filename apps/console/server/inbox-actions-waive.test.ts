import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import type { DecisionLog } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import type { WatchRow } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const RUN = "11111111-0000-4000-8000-000000000001";
const SENT_BACK_ID = `${RUN}/sh-sent-back`;
const ITEM_ID = `gate:${SENT_BACK_ID}`;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

const WAIT = { id: "await-new-head", label: "Wait for a new head" };
const ABANDON = { id: "abandon", label: "Abandon the PR" };
const WAIVE = { id: "waive-proof", label: "Waive the fix-proof at this head" };

let dir: string;
let factory: FakeDaemon | undefined;
let items: OwnerItem[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-waive-"));
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

function sentBackItem(options: { id: string; label: string }[]): void {
  items = [
    {
      id: ITEM_ID,
      sources: [{ system: "hitl", ref: SENT_BACK_ID }],
      kind: "approve",
      door: "one-way",
      summary: `Merge ${REPO} run ${RUN.slice(0, 8)}?`,
      context: "",
      keys: [ITEM_ID, `run:${RUN}`],
      personal: false,
      lens: "blocking-merge",
      unblocks: [],
      openedAt: "2026-10-10T03:00:00.000Z",
      status: "open",
      options,
    },
  ];
}

const row: WatchRow = {
  repo: REPO,
  pr: 1,
  branch: "feat/1",
  runId: RUN,
  task: "EX-1",
  phase: "awaiting-approval",
  headSha: HEAD,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "owner: resolve sh-sent-back",
  pendingGate: { gateId: SENT_BACK_ID, stepId: "sh-sent-back", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
};

const actionsDir = () => path.join(dir, "owner-actions");

const recordShape = z.object({ action: z.object({ gateId: z.string().optional(), headSha: z.string() }) });

/** The factory route as the console sees it: it resolves the gate a record at the live head names. */
function spyFactory() {
  const posts: string[] = [];
  const client: OwnerActionClient = {
    post: async (actionId): Promise<ActionOutcome> => {
      posts.push(actionId);
      const bytes = await readFile(path.join(actionsDir(), `${actionId}.json`));
      const record = recordShape.parse(JSON.parse(bytes.toString("utf8")));
      if (record.action.headSha !== HEAD) return { status: "moved", currentHead: HEAD };
      return { status: "resolved", gateId: record.action.gateId! };
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

const ownerContext = (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: SESSION, ownerWrites: true });

async function harness(client: OwnerActionClient, decisionLog?: DecisionLog) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command === "needs.list") return { items, gaps: [] };
    if (command === "shepherd.list") return [row];
    if (command === "shepherd.timeline") return { row: args.pr === row.pr ? row : undefined, entries: [] };
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, now: () => Date.parse("2026-10-10T06:00:00.000Z"), ...(decisionLog && { decisionLog }) });
  return {
    prepare: async (decision?: string) => (await invokeCommand(commands["inbox.prepare"], { itemId: ITEM_ID, ...(decision !== undefined && { decision }) }, ownerContext())).envelope,
    act: (confirm: string, decision?: string) => invokeCommand(commands["inbox.act"], { itemId: ITEM_ID, confirm, ...(decision !== undefined && { decision }) }, ownerContext()),
  };
}

const readyEnvelope = z.object({ ok: z.literal(true), data: z.custom<Extract<PrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) });

const ready = (envelope: JsonEnvelope<unknown>) => readyEnvelope.parse(envelope).data;

const readRecord = async (confirm: string) => JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"));

describe("inbox.act on a waivable sh-sent-back gate", () => {
  it("waives the fix-proof as a second tap: the read-back says this head only and no merge, and the record names waive-proof alone", async () => {
    sentBackItem([WAIT, ABANDON, WAIVE]);
    const factorySpy = spyFactory();
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(factorySpy.client, log);
    const prepared = ready(await prepare("waive-proof"));

    const { envelope } = await act(prepared.confirm, "waive-proof");

    expect(prepared.readBack).toMatchObject({ gateId: SENT_BACK_ID, headSha: HEAD, effect: `Skip the fix-proof requirement for ${REPO}#1 at 1234567 only, so Shepherd reviews this head. This tap merges nothing: the merge still needs your Approve merge tap, and a new push asks again` });
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "resolved" }, message: "Fix-proof waived at this head; nothing merged. Shepherd reviews it, and the merge waits for your Approve merge" } });
    expect((await readRecord(prepared.confirm)).action).toEqual({ kind: "resolve-gate", gateId: SENT_BACK_ID, runId: RUN, stepId: "sh-sent-back", repo: REPO, pr: 1, headSha: HEAD, decision: "waive-proof" });
    expect(factorySpy.posts).toEqual([prepared.confirm]);
    expect(calls[0]![1]).toMatchObject({ text: "waive-proof" });
  });

  it("keeps await-new-head as the item's own tap beside the waiver", async () => {
    sentBackItem([WAIT, ABANDON, WAIVE]);
    const { prepare, act } = await harness(spyFactory().client);
    const prepared = ready(await prepare());

    const { envelope } = await act(prepared.confirm);

    expect(prepared.action).toMatchObject({ decision: "await-new-head", alternatives: ["waive-proof"] });
    expect(envelope).toMatchObject({ ok: true, data: { message: "Waiting for the implementer's next pushed head; nothing merged" } });
    expect((await readRecord(prepared.confirm)).action).not.toHaveProperty("alternatives");
  });

  it("offers no waive-proof tap on a sent-back gate whose options lack it", async () => {
    sentBackItem([WAIT, ABANDON]);
    const { prepare } = await harness(spyFactory().client);

    const envelope = await prepare("waive-proof");

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", reason: "this item offers no waive-proof tap" } });
  });

  it("refuses a waive-proof act on the confirm of an await-new-head read-back, and writes no record", async () => {
    sentBackItem([WAIT, ABANDON, WAIVE]);
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());

    const { envelope } = await act(confirm, "waive-proof");

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(factorySpy.posts).toEqual([]);
    expect(await readdir(actionsDir()).catch(() => [] as string[])).toEqual([]);
  });
});
