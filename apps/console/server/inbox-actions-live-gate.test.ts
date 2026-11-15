import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { depositItemId, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { invokeCommand } from "@titan-design/registry";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands } from "./inbox-actions.js";
import type { WatchRow } from "./inbox-view.js";
import type { OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const ASKER = "test-asker";
const RUN_PLAIN = "11111111-0000-4000-8000-000000000001";
const PLAIN_ID = `gate:${RUN_PLAIN}/approve-merge`;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const context: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION, ownerWrites: true };

let dir: string;
let factory: FakeDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-live-gate-"));
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const gate: OwnerItem = {
  id: PLAIN_ID,
  sources: [{ system: "hitl", ref: `${RUN_PLAIN}/approve-merge` }],
  kind: "approve",
  door: "one-way",
  summary: `Merge ${REPO} run 11111111?`,
  context: "",
  keys: [PLAIN_ID, `run:${RUN_PLAIN}`],
  personal: false,
  lens: "blocking-merge",
  unblocks: [],
  openedAt: "2026-10-10T03:00:00.000Z",
  status: "open",
};

const liveRow: WatchRow = {
  repo: REPO,
  pr: 1,
  branch: "feat/1",
  runId: RUN_PLAIN,
  task: "EX-1",
  phase: "awaiting-approval",
  headSha: HEAD,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "owner: resolve approve-merge",
  pendingGate: { gateId: `${RUN_PLAIN}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
};

describe("inbox.prepare on a deposit carrying a live gate's key", () => {
  it("gives the deposit only its own answer, never the gate's tap", async () => {
    await writeDeposit(path.join(dir, "deposits"), { depositId: "queue-1", asker: ASKER, kind: "do", door: "two-way", summary: "Resolve the plain gate", context: "", keys: [PLAIN_ID, `run:${RUN_PLAIN}`], command: "titan-factory shepherd waiting" });
    factory = await startFakeDaemon({ ok: true }, (command) => {
      if (command === "needs.list") return { items: [gate], gaps: [] };
      if (command === "shepherd.list") return [liveRow];
      throw new Error(`no fixture for ${command}`);
    });
    const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
    const client: OwnerActionClient = { post: async () => ({ status: "gone", reason: "never posted" }) };
    const commands = inboxActionCommands(sources, { enabled: true, actionsDir: path.join(dir, "owner-actions"), client, now: () => Date.parse("2026-10-10T06:00:00.000Z") });

    const { envelope } = await invokeCommand(commands["inbox.prepare"], { itemId: depositItemId(ASKER, "queue-1") }, context);

    expect(envelope).toMatchObject({ ok: true, data: { status: "ready", action: { kind: "answer-deposit" } } });
  });
});
