import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { consoleCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import type { ConsoleContext } from "./owner-guard.js";
import { copiedRounds, type CopiedRounds } from "./round-fixtures.js";
import type { ShepherdSource } from "./shepherd.js";
import { createSources } from "./upstreams.js";

const SHOWN = "orbit-retry-r1";
const GATE_REF = "run-orbit-12/approve-merge";
const OWNER_CONTEXT: ConsoleContext = {
  warnings: [],
  format: "json",
  surface: "http",
  auth: { credential: "session", issuedAt: 1_000, peerLocal: false } satisfies RequestAuth,
  ownerWrites: true,
};

/** The merge gate the round's Ship answers; the factory drops it once the round's answer reaches it. */
const GATE: OwnerItem = {
  id: `gate:${GATE_REF}`, sources: [{ system: "hitl", ref: GATE_REF }], kind: "approve", door: "one-way", summary: "Merge example/orbit-relay#12", context: "",
  keys: [], personal: false, lens: "blocking-merge", unblocks: [], openedAt: "2031-03-04T12:00:00.000Z", status: "open",
};

const listed = z.object({ items: z.array(z.object({ id: z.string() })) });

let root: string;
let rounds: CopiedRounds;
let gateOpen: boolean;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-inbox-submit-"));
  rounds = await copiedRounds();
  gateOpen = true;
});

afterEach(async () => {
  await rounds.remove();
  await rm(root, { recursive: true, force: true });
});

/** The console's own commands over a fake factory and Shepherd, with no listener, so no answer leaves the test. */
function commands() {
  const factory: FactoryNeeds = { list: () => Promise.resolve({ items: gateOpen ? [GATE] : [], gaps: [] }) };
  const shepherd = partialFake<ShepherdSource>({ list: () => Promise.resolve([]) });
  const broker = partialFake<BrokerReader>({ read: () => Promise.reject(new Error("no broker in this test")) });
  const agents = partialFake<AgentsSource>({ broker, eventsDbPath: "", seatPrefixes: [] });
  const wired = createSources(resolveConfig({}, root));
  return consoleCommands({ ...wired, factory, shepherd, agents, rounds: rounds.source, inbox: { dir: path.join(root, "inbox") }, listeners: undefined, decisionLog: undefined });
}

async function listInbox(served: ReturnType<typeof commands>): Promise<string[]> {
  const { envelope } = await invokeCommand(served["inbox.list"], { planning: true }, OWNER_CONTEXT);
  if (!envelope.ok) throw new Error("inbox.list was refused");
  return listed.parse(envelope.data).items.map((item) => item.id);
}

async function submitShown(served: ReturnType<typeof commands>): Promise<void> {
  const manifestSha256 = createHash("sha256").update(await readFile(path.join(rounds.source.dir, SHOWN, "round.json"))).digest("hex");
  const args = { id: SHOWN, manifestSha256, headSha: "0123456789abcdef0123456789abcdef01234567", answers: [{ questionId: "ship-backoff", pick: "Ship" }] };
  const { envelope } = await invokeCommand(served["rounds.submit"], args, OWNER_CONTEXT);
  if (!envelope.ok) throw new Error("the fixture submit was refused");
}

describe("inbox.list after a round is submitted", () => {
  it("drops the submitted round and the gate its answer settled on the next call", async () => {
    const served = commands();
    const before = await listInbox(served);

    gateOpen = false;
    await submitShown(served);
    const after = await listInbox(served);

    expect(before).toContain(GATE.id);
    expect(before.some((id) => id.startsWith(`round:${SHOWN}/`))).toBe(true);
    expect(after).not.toContain(GATE.id);
    expect(after.some((id) => id.startsWith(`round:${SHOWN}/`))).toBe(false);
  });
});
