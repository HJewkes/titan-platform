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
import { decisionTaskItem } from "./active-work-source.js";
import { runNeeds } from "./command.js";
import type { NeedsSources } from "../context.js";
import { z } from "zod";

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function serve(needsSources: NeedsSources): Promise<FactoryServer> {
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
  await runNeeds({ stdout: (text) => void out.push(text), stderr: () => undefined }, sources ?? (await sources10_05()), { json: true });
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

async function mcpNeedsIds(server: FactoryServer): Promise<string[]> {
  const { tools } = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(await mcp(server, "tools/list", {}));
  const name = tools.map((tool) => tool.name).find((each) => each.includes("needs") && each.endsWith("list"))!;
  const { content } = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(await mcp(server, "tools/call", { name, arguments: {} }));
  const items = z.object({ items: z.array(z.object({ id: z.string() })) });
  const parsed = z.union([items, z.object({ data: items }).transform((envelope) => envelope.data)]).parse(JSON.parse(content[0]!.text));
  return parsed.items.map((item) => item.id);
}

describe("needs.list for an owner-only initiative", () => {
  it("serves its items to the owner's console over /rpc and hides them from an agent over MCP", async () => {
    const withheld = decisionTaskItem({ ...decisionTask(1), slug: "private-plans" }, false, true);
    const server = await serve(() => sources10_05([withheld]));

    const owner = await rpc<{ items: OwnerItem[] }>(server, "needs.list");
    const agent = await mcpNeedsIds(server);

    expect(owner.items.map((item) => item.id)).toContain(withheld.id);
    expect(agent).not.toContain(withheld.id);
    expect(agent.length).toBeGreaterThan(0);
  });

  it("hides them from `needs --json` unless the shell is the owner's", async () => {
    const withheld = decisionTaskItem({ ...decisionTask(1), slug: "private-plans" }, false, true);
    const sources = await sources10_05([withheld]);
    const ids = async (ownerOnly: boolean) => {
      const out: string[] = [];
      await runNeeds({ stdout: (text) => void out.push(text), stderr: () => undefined }, sources, { json: true, ownerOnly });
      return z.array(z.object({ id: z.string() })).parse(JSON.parse(out.join(""))).map((item) => item.id);
    };

    expect(await ids(true)).toContain(withheld.id);
    expect(await ids(false)).not.toContain(withheld.id);
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
