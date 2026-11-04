import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import type { WatchRow } from "./inbox-view.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

/** TP-4404: an owner-at-head merge gate's tap reads back the factory's evidence card and posts its digest; all text is synthetic. */
const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const OTHER_HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const BASE = "0000000000aaaaaaaaaa0000000000aaaaaaaaaa";
const RUN = "11111111-0000-4000-8000-000000000001";
const GATE_ID = `${RUN}/approve-merge`;
const ITEM_ID = `gate:${GATE_ID}`;
const DIGEST = "e".repeat(64);
const COMMAND = `titan-factory gate resolve ${RUN} approve-merge --json '{"decision":"merge","headSha":"${HEAD}"}'`;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

const SECTION = {
  fact: "ci-policy-weakened",
  ciPolicy: { kind: "weakened", keys: ["other"] },
  verdictLines: ["The synthetic job is no longer required.", "CI-policy: weakened other"],
  labelledLines: [{ raw: "CI-policy: weakened other", reading: { kind: "weakened", keys: ["other"] } }],
  files: [{ path: ".github/workflows/ci.yml", rows: [{ side: "-", n: 3, text: "required: true\\u{A}" }, { side: "+", n: 3, text: "required: false\\u{A}" }] }],
};
const READY = { status: "ready", gateId: GATE_ID, head: HEAD, mergeBase: BASE, facts: ["ci-policy-weakened"], sections: [SECTION], digest: DIGEST };

let dir: string;
let factory: FakeDaemon | undefined;
let evidence: unknown;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-evidence-"));
  evidence = READY;
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const item: OwnerItem = {
  id: ITEM_ID,
  sources: [{ system: "hitl", ref: GATE_ID }],
  kind: "approve",
  door: "one-way",
  summary: `Merge ${REPO}#1?`,
  context: "",
  keys: [ITEM_ID, `run:${RUN}`],
  personal: false,
  lens: "blocking-merge",
  unblocks: [],
  openedAt: "2026-10-10T03:00:00.000Z",
  status: "open",
};

const row: WatchRow = {
  repo: REPO,
  pr: 1,
  branch: "feat/1",
  runId: RUN,
  task: "EX-1",
  phase: "awaiting-approval",
  headSha: HEAD,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "owner: resolve approve-merge",
  pendingGate: { gateId: GATE_ID, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
};

const actionsDir = () => path.join(dir, "owner-actions");

function spyFactory() {
  const posts: string[] = [];
  const client: OwnerActionClient = {
    post: async (actionId): Promise<ActionOutcome> => {
      posts.push(actionId);
      return { status: "resolved", gateId: GATE_ID };
    },
  };
  return { client, posts };
}

const ownerContext = (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: SESSION, ownerWrites: true });

async function harness(client: OwnerActionClient) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command === "needs.list") return { items: [item], gaps: [] };
    if (command === "shepherd.list") return [row];
    if (command === "gate.ownerEvidence" && args.gateId === GATE_ID) return evidence;
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, now: () => Date.parse("2026-10-10T06:00:00.000Z") });
  return {
    prepare: async () => (await invokeCommand(commands["inbox.prepare"], { itemId: ITEM_ID }, ownerContext())).envelope,
    act: (confirm: string) => invokeCommand(commands["inbox.act"], { itemId: ITEM_ID, confirm }, ownerContext()),
  };
}

const readyEnvelope = z.object({ ok: z.literal(true), data: z.custom<Extract<PrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) });
const ready = (envelope: JsonEnvelope<unknown>) => readyEnvelope.parse(envelope).data;
const readRecord = async (confirm: string) => JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"));

describe("inbox tap on an owner-at-head merge gate", () => {
  it("reads back every fact's evidence and posts the record with that evidence's digest", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const prepared = ready(await prepare());

    const { envelope } = await act(prepared.confirm);

    expect(prepared.readBack).toMatchObject({ gateId: GATE_ID, headSha: HEAD, evidence: { facts: ["ci-policy-weakened"], mergeBase: BASE, sections: [SECTION], digest: DIGEST } });
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "resolved" } } });
    expect((await readRecord(prepared.confirm)).action).toEqual({ kind: "resolve-gate", gateId: GATE_ID, runId: RUN, stepId: "approve-merge", repo: REPO, pr: 1, headSha: HEAD, decision: "merge", evidenceDigest: DIGEST });
    expect(factorySpy.posts).toEqual([prepared.confirm]);
  });

  it("offers no tap, naming the facts, the reason and the terminal command, when the card cannot show all of it", async () => {
    evidence = { status: "missing", gateId: GATE_ID, facts: ["files-unread"], reason: "the merge evidence holds no changed-file list the card can show (files-unread)", command: COMMAND };
    const { prepare } = await harness(spyFactory().client);

    const envelope = await prepare();

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", reason: `the owner reads files-unread at their own head, and the merge evidence holds no changed-file list the card can show (files-unread); run ${COMMAND}` } });
  });

  it("offers no tap on evidence read at another head than the item's", async () => {
    evidence = { ...READY, head: OTHER_HEAD };
    const { prepare } = await harness(spyFactory().client);

    const envelope = await prepare();

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", reason: "the evidence was read at abcdef1, not at 1234567; read the item again" } });
  });

  it("refuses the confirm once the evidence changed after it was read, and writes no record", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());
    evidence = { ...READY, digest: "f".repeat(64) };

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(factorySpy.posts).toEqual([]);
    expect(await readdir(actionsDir()).catch(() => [] as string[])).toEqual([]);
  });

  it("posts no digest for a gate that names no owner-at-head fact", async () => {
    evidence = { status: "none", gateId: GATE_ID };
    const { prepare, act } = await harness(spyFactory().client);
    const prepared = ready(await prepare());

    await act(prepared.confirm);

    expect(prepared.readBack).not.toHaveProperty("evidence");
    expect((await readRecord(prepared.confirm)).action).not.toHaveProperty("evidenceDigest");
  });
});
