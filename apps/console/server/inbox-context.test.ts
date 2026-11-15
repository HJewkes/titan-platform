import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import type { AgentsSource } from "./agents.js";
import type { FactoryNeeds } from "./approvals.js";
import { consoleCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import type { ConsoleContext } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import { createSources } from "./upstreams.js";

const OWNER_CONTEXT: ConsoleContext = {
  warnings: [],
  format: "json",
  surface: "http",
  auth: { credential: "session", issuedAt: 1_000, peerLocal: false } satisfies RequestAuth,
  ownerWrites: true,
};

const LONG_CONTEXT = "A long synthetic context. ".repeat(80);
const RATIONALE = "Flat names read better in listings.";
const CITE = { session: "session-1", event: "evt-7", quote: "flat names" };

const DEPOSIT: OwnerItem = {
  id: "chat:msg-0042", sources: [{ system: "agent-chat", ref: "msg-0042" }], kind: "decide", door: "two-way", summary: "Which fixture name fits?",
  context: LONG_CONTEXT, keys: [], asker: "test-asker", personal: false, lens: "blocking-agent", unblocks: [], openedAt: "2031-03-04T12:00:00.000Z", status: "open",
  options: [{ id: "flat", label: "Flat" }, { id: "nested", label: "Nested" }],
  recommended: { optionId: "flat", by: "test-asker", rationale: RATIONALE, cite: CITE },
};

let root: string;
let factoryReads: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-inbox-context-"));
  factoryReads = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function commands() {
  const factory: FactoryNeeds = {
    list: () => {
      factoryReads += 1;
      return Promise.resolve({ items: [DEPOSIT], gaps: [] });
    },
  };
  const shepherd = partialFake<ShepherdSource>({ list: () => Promise.resolve([]), waiting: () => Promise.resolve({ owner: [], seat: [] }) });
  const agents = partialFake<AgentsSource>({ eventsDbPath: "", seatPrefixes: [] });
  const wired = createSources(resolveConfig({}, root));
  return consoleCommands({ ...wired, factory, shepherd, agents, inbox: { dir: path.join(root, "inbox") }, listeners: undefined, decisionLog: undefined });
}

describe("inbox.context", () => {
  it("returns a deposit's whole context and its recommendation's rationale and cite", async () => {
    const { envelope } = await invokeCommand(commands()["inbox.context"], { itemId: DEPOSIT.id }, OWNER_CONTEXT);

    expect(envelope).toMatchObject({ ok: true, data: { itemId: DEPOSIT.id, context: LONG_CONTEXT, rationale: RATIONALE, cite: CITE } });
  });

  it("fails as no input for an id that is not open", async () => {
    const { envelope, exitCode } = await invokeCommand(commands()["inbox.context"], { itemId: "chat:unknown" }, OWNER_CONTEXT);

    expect(envelope).toMatchObject({ ok: false });
    expect(exitCode).toBe(66);
  });

  it("reads the factory once for two calls inside the cache window", async () => {
    const served = commands();

    await invokeCommand(served["inbox.context"], { itemId: DEPOSIT.id }, OWNER_CONTEXT);
    await invokeCommand(served["inbox.context"], { itemId: DEPOSIT.id }, OWNER_CONTEXT);

    expect(factoryReads).toBe(1);
  });
});
