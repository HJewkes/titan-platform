import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RequestAuth } from "@titan-design/daemon";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import type { AgentsSource } from "./agents.js";
import type { FactoryNeeds } from "./approvals.js";
import type { BrokerReader } from "./broker.js";
import type { BrokerAnswerer } from "./broker-answer.js";
import { consoleCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import { createInvalidation, type Invalidation } from "./invalidation.js";
import { inboxReadCache } from "./inbox-rows.js";
import type { WatchRow } from "./inbox-view.js";
import type { ConsoleContext } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import type { LineageReader, ShipLineage } from "./ship-lineage.js";
import { createSources } from "./upstreams.js";

const MSG = "msg-0042";
const RUN = "11111111-0000-4000-8000-000000000001";
const SHA = "1234567890abcdef1234567890abcdef12345678";
const BASE = "abcdef1234567890abcdef1234567890abcdef12";
const KNOWN: ShipLineage = { known: true, provenSha: SHA, state: "open", merged: false, mergeSha: null, headSha: SHA, baseRef: "main", baseSha: BASE, behind: 0 };
const CHAT_ID = `chat:${MSG}`;
const OWNER_CONTEXT: ConsoleContext = {
  warnings: [],
  format: "json",
  surface: "http",
  auth: { credential: "session", issuedAt: 1_000, peerLocal: false } satisfies RequestAuth,
  ownerWrites: true,
};

/** An agent's question the factory lists, so its tap reads back from the item alone and needs no Shepherd row. */
const ASK: OwnerItem = {
  id: CHAT_ID, sources: [{ system: "agent-chat", ref: MSG }], kind: "decide", door: "two-way", summary: "Which fixture name fits?", context: "Pick one.",
  keys: [], asker: "test-asker", personal: false, lens: "blocking-agent", unblocks: [], openedAt: "2031-03-04T12:00:00.000Z", status: "open",
};

const ready = z.object({ ok: z.literal(true), data: z.object({ status: z.literal("ready"), confirm: z.string() }) });
const listed = z.object({ ok: z.literal(true), data: z.object({ items: z.array(z.object({ id: z.string() })) }) });

let root: string;
let factoryReads: number;
let nextRead: () => Promise<{ items: OwnerItem[]; gaps: string[] }>;
let liveRows: WatchRow[];
let timelines: number[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-inbox-upstream-reads-"));
  factoryReads = 0;
  liveRows = [];
  timelines = [];
  nextRead = () => Promise.resolve({ items: [ASK], gaps: [] });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function commands(invalidation?: Invalidation) {
  const factory: FactoryNeeds = {
    list: () => {
      factoryReads += 1;
      return nextRead();
    },
  };
  const shepherd = partialFake<ShepherdSource>({
    list: (state) => Promise.resolve(state === "active" ? liveRows : []),
    waiting: () => Promise.resolve({ owner: [], seat: [] }),
    timeline: (_repo, pr) => {
      timelines.push(pr);
      return Promise.reject(new Error("no timeline in this test"));
    },
  });
  const answerer: BrokerAnswerer = { answer: () => Promise.resolve({ status: "answered" }) };
  const inboxActions = { enabled: true, actionsDir: path.join(root, "actions"), client: { post: () => Promise.resolve({ status: "off" as const }) }, answerer };
  const broker = partialFake<BrokerReader>({ read: () => Promise.reject(new Error("no broker in this test")) });
  const agents = partialFake<AgentsSource>({ broker, eventsDbPath: "", seatPrefixes: [] });
  const wired = createSources(resolveConfig({}, root));
  return consoleCommands({ ...wired, factory, shepherd, agents, inbox: { dir: path.join(root, "inbox") }, listeners: undefined, decisionLog: undefined, inboxActions, ...(invalidation && { invalidation }) });
}

/** A gate the factory files under planning, joined to a live Shepherd row at a pinned head. */
function collapsedGate(): OwnerItem {
  const ref = `${RUN}/approve-merge`;
  return { ...ASK, id: `gate:${ref}`, sources: [{ system: "hitl", ref }], kind: "approve", lens: "planning" };
}

function liveRow(): WatchRow {
  return {
    repo: "example/repo", pr: 7, branch: "feat/x", runId: RUN, task: "example/EX-1", phase: "approve", headSha: SHA, phaseSince: "2031-03-04T12:00:00.000Z",
    nextAction: "approve-merge", pendingGate: { gateId: `${RUN}/approve-merge`, stepId: "approve-merge", since: "2031-03-04T12:00:00.000Z" }, held: null, stalled: null,
  };
}

async function listIds(served: ReturnType<typeof commands>, planning = true): Promise<string[]> {
  const { envelope } = await invokeCommand(served["inbox.list"], { planning }, OWNER_CONTEXT);
  return listed.parse(envelope).data.items.map((item) => item.id);
}

describe("inbox taps beside the inbox", () => {
  it("prepare and act reuse the inbox's fresh needs read instead of reading the factory again", async () => {
    const served = commands();
    await listIds(served);

    const prepared = ready.parse((await invokeCommand(served["inbox.prepare"], { itemId: CHAT_ID }, OWNER_CONTEXT)).envelope);
    const acted = await invokeCommand(served["inbox.act"], { itemId: CHAT_ID, confirm: prepared.data.confirm, text: "alpha" }, OWNER_CONTEXT);

    expect(acted.envelope).toMatchObject({ ok: true, data: { outcome: { status: "answered" } } });
    expect(factoryReads).toBe(1);
  });

  it("a factory frame serves the kept needs read while one refresh runs behind it", async () => {
    const invalidation = createInvalidation();
    const served = commands(invalidation);
    await listIds(served);
    nextRead = () => new Promise(() => undefined);

    invalidation.emit("factory");
    const ids = await listIds(served);

    expect(ids).toEqual([CHAT_ID]);
    expect(factoryReads).toBe(2);
  });
});

describe("inbox.list's GitHub reads", () => {
  it("reads no gate strip for a row the default view keeps collapsed under planning", async () => {
    nextRead = () => Promise.resolve({ items: [collapsedGate()], gaps: [] });
    liveRows = [liveRow()];
    const served = commands();

    const shown = await listIds(served, false);
    await listIds(served, true);

    expect(shown).toEqual([]);
    expect(timelines).toEqual([7]);
  });
});

describe("inboxReadCache", () => {
  const sources = (lineage?: LineageReader, now = () => 0) => ({
    factory: { list: () => Promise.resolve({ items: [], gaps: [`read ${++factoryReads}`] }) },
    shepherd: partialFake<ShepherdSource>({ list: () => Promise.resolve([]) }),
    rounds: { dir: "/synthetic/rounds", ...(lineage && { lineage }) },
    inbox: { dir: "/synthetic/inbox" },
    now,
  });

  it("serves a merge row's kept lineage while one refresh runs behind it, and never keeps an unknown one", async () => {
    let clock = 0;
    const reads: string[] = [];
    const answers: ShipLineage[] = [{ known: false, reason: "github timed out" }, KNOWN, KNOWN];
    const lineage: LineageReader = (binding) => {
      reads.push(binding.headSha);
      return Promise.resolve(answers[reads.length - 1] ?? KNOWN);
    };
    const cache = inboxReadCache(sources(lineage, () => clock));
    const binding = { repo: "example/repo", pr: 7, headSha: SHA };

    const first = await cache.lineage!(binding);
    await cache.lineage!(binding);
    clock = 61_000;
    const past = await cache.lineage!(binding);

    expect(first).toEqual({ known: false, reason: "github timed out" });
    expect(past).toEqual(KNOWN);
    expect(reads).toHaveLength(3);
  });

  it("marks the kept reads stale without dropping them", async () => {
    const cache = inboxReadCache(sources());
    await cache.factory!.list();

    cache.stale();
    const served = await cache.factory!.list();

    expect(served.gaps).toEqual(["read 1"]);
    expect(factoryReads).toBe(2);
  });
});
