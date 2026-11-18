import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import type { OwnerItem, QueueSource } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it } from "vitest";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { landScenario } from "../test-support/land.js";
import { sources10_05 } from "../test-support/needs-10-05.js";
import { decisionTask } from "../test-support/owner-queue-10-05.js";
import { SHOWN_SLUG, WITHHELD_SLUG, shownTask, withheldTask } from "../test-support/needs-daemon.js";
import { decisionTaskItem } from "./active-work-source.js";
import type { AgentAllowList } from "./agent-allow-list.js";
import { toOwnerItem } from "./agent-chat-item.js";
import { runNeeds } from "./command.js";
import type { NeedsSources } from "../context.js";
import { z } from "zod";

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function serve(needsSources: NeedsSources, needsAllowed?: AgentAllowList): Promise<FactoryServer> {
  const dir = mkdtempSync(join(tmpdir(), "factory-needs-rpc-"));
  dirs.push(dir);
  const scenario = landScenario();
  const server = await startFactoryServer({
    dbPath: join(dir, "state", "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    resyncOnStart: false,
    needsSources,
    ...(needsAllowed && { needsAllowed }),
  });
  servers.push(server);
  return server;
}

async function rpc<T>(server: FactoryServer, name: string, args: object = {}): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-titan-client": "test" },
    body: JSON.stringify(args),
  });
  const envelope = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

async function cliJson(sources?: readonly QueueSource[]) {
  const out: string[] = [];
  await runNeeds({ stdout: (text) => void out.push(text), stderr: () => undefined }, sources ?? (await sources10_05()), { json: true }, { caller: "owner" });
  return z.array(z.looseObject({ kind: z.string(), lens: z.string().optional() })).parse(JSON.parse(out.join("")));
}

const fixed10_05: NeedsSources = () => sources10_05();

describe("needs.list over the daemon", () => {
  it("returns the same merged OwnerItem[] that `needs --json` prints on the 10-05 fixture", async () => {
    const sources = await sources10_05();
    const server = await serve(() => sources);

    const list = await rpc<{ items: OwnerItem[]; gaps: string[] }>(server, "needs.list");

    expect(list.items).toEqual(await cliJson(sources));
    expect(list.gaps).toEqual([]);
  });

  it("narrows the list by kind, lens and initiative", async () => {
    const server = await serve(fixed10_05);

    const approvals = await rpc<{ items: OwnerItem[] }>(server, "needs.list", { kind: "approve", lens: "blocking-agent" });
    const initiative = decisionTask(1).slug;
    const scoped = await rpc<{ items: OwnerItem[] }>(server, "needs.list", { initiative });

    expect(approvals.items.length).toBeGreaterThan(0);
    for (const item of approvals.items) expect(item).toMatchObject({ kind: "approve", lens: "blocking-agent" });
    expect(scoped.items.length).toBeGreaterThan(0);
    for (const item of scoped.items) expect(item.initiative).toBe(initiative);
  });

  it("with fyi count, sends every ask whole and only the number of fyi items", async () => {
    const sources = await sources10_05();
    const server = await serve(() => sources);

    const full = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const slim = await rpc<{ items: OwnerItem[]; gaps: string[]; fyiCount: number }>(server, "needs.list", { fyi: "count" });

    const fyi = full.items.filter((item) => item.lens === "fyi" && item.status === "open");
    expect(fyi.length).toBeGreaterThan(0);
    expect(slim.items).toEqual(full.items.filter((item) => !fyi.includes(item)));
    expect(slim.fyiCount).toBe(fyi.length);
    expect(slim.gaps).toEqual([]);
  });

  it("leaves personal items out unless they are asked for", async () => {
    const personal = decisionTaskItem({ ...decisionTask(1), slug: "diary" }, true);
    const asked: boolean[] = [];
    const server = await serve(({ personal: include }) => {
      asked.push(include);
      return sources10_05([personal]);
    });

    const plain = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const withPersonal = await rpc<{ items: OwnerItem[] }>(server, "needs.list", { personal: true });

    expect(plain.items.map((item) => item.id)).not.toContain(personal.id);
    expect(withPersonal.items.map((item) => item.id)).toContain(personal.id);
    expect(asked).toEqual([false, true]);
  });
});

/** One JSON-RPC call to serve's MCP endpoint; the streamable transport may answer as one SSE event. */
async function mcp(server: FactoryServer, method: string, params: object): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-titan-client": "test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return z.object({ result: z.unknown() }).parse(JSON.parse(data ? data.slice("data: ".length) : text)).result;
}

const mcpListSchema = z.object({ items: z.array(z.looseObject({ id: z.string(), initiative: z.string().optional() })), gaps: z.array(z.string()) });

async function mcpNeeds(server: FactoryServer): Promise<z.infer<typeof mcpListSchema>> {
  const { tools } = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(await mcp(server, "tools/list", {}));
  const name = tools.map((tool) => tool.name).find((each) => each.includes("needs") && each.endsWith("list"))!;
  const { content } = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(await mcp(server, "tools/call", { name, arguments: {} }));
  return z.union([mcpListSchema, z.object({ data: mcpListSchema }).transform((envelope) => envelope.data)]).parse(JSON.parse(content[0]!.text));
}

const ids = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);

/** Adds one item to a system's source, so a test can tag any source with an initiative. */
function withItem(sources: readonly QueueSource[], item: OwnerItem): QueueSource[] {
  const system = item.sources[0]!.system;
  return sources.map((source) => (source.system === system ? { ...source, open: async () => [...(await source.open()), item] } : source));
}

const allowed: AgentAllowList = async () => new Set([SHOWN_SLUG, decisionTask(1).slug]);

const brokerAsk = (initiative: string): OwnerItem =>
  toOwnerItem({ msgId: "m-90", kind: "question", from: "agent-1", text: "Which storage plan?", at: Date.parse("2026-01-05T10:00:00Z"), meta: { kind: "decision", initiative } });

async function morningItem(initiative: string): Promise<OwnerItem> {
  const morning = await (await sources10_05()).find((source) => source.system === "morning")!.open();
  return { ...morning[0]!, id: "morning:private", keys: [], summary: "Pick the private plan's storage", initiative };
}

describe("needs.list for an initiative withheld from agents (TP-5556)", () => {
  it("serves a withheld needs-decision task over /rpc and hides it over MCP", async () => {
    const tasks = [decisionTaskItem(withheldTask, false), decisionTaskItem(shownTask, false)];
    const server = await serve(() => sources10_05(tasks), allowed);

    const owner = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const agent = await mcpNeeds(server);

    expect(ids(owner.items)).toContain("task:PP-7");
    expect(ids(agent.items)).not.toContain("task:PP-7");
    expect(ids(agent.items)).toContain("task:AL-1");
  });

  it("hides an agent-chat ask whose initiative meta is withheld over MCP and shows it over /rpc", async () => {
    const ask = brokerAsk(WITHHELD_SLUG);
    const server = await serve(async () => withItem(await sources10_05(), ask), allowed);

    const owner = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const agent = await mcpNeeds(server);

    expect(ids(owner.items)).toContain(ask.id);
    expect(ids(agent.items)).not.toContain(ask.id);
  });

  it("hides a Morning item tagged with a withheld initiative over MCP", async () => {
    const item = await morningItem(WITHHELD_SLUG);
    const server = await serve(async () => withItem(await sources10_05(), item), allowed);

    const owner = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const agent = await mcpNeeds(server);

    expect(ids(owner.items)).toContain(item.id);
    expect(ids(agent.items)).not.toContain(item.id);
  });

  it("gives an agent no initiative-tagged item when inventory is down, but keeps the untagged gates", async () => {
    const down: AgentAllowList = async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:7400"));
    const server = await serve(async () => withItem(await sources10_05([decisionTaskItem(shownTask, false)]), brokerAsk(SHOWN_SLUG)), down);

    const agent = await mcpNeeds(server);

    expect(agent.items.filter((item) => item.initiative !== undefined)).toEqual([]);
    expect(agent.items.some((item) => item.id.startsWith("gate:"))).toBe(true);
    expect(agent.gaps).toEqual(["active-work inventory: connect ECONNREFUSED 127.0.0.1:7400; initiative items withheld"]);
  });
});

describe("needs.count over the daemon", () => {
  it("counts the merged list by kind and lens under the same filters", async () => {
    const server = await serve(fixed10_05);
    const items = await cliJson();

    const all = await rpc<{ total: number; byKind: Record<string, number>; byLens: Record<string, number> }>(server, "needs.count");
    const approvals = await rpc<{ total: number }>(server, "needs.count", { kind: "approve" });

    expect(all.total).toBe(items.length);
    expect(all.byKind["approve"]).toBe(items.filter((item) => item.kind === "approve").length);
    expect(all.byLens["planning"]).toBe(items.filter((item) => item.lens === "planning").length);
    expect(approvals.total).toBe(all.byKind["approve"]);
  });
});
