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
import type { NeedsSources } from "./rpc.js";

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

async function cliJson(sources?: readonly QueueSource[]): Promise<OwnerItem[]> {
  const out: string[] = [];
  await runNeeds({ stdout: (text) => void out.push(text), stderr: () => undefined }, sources ?? (await sources10_05()), { json: true });
  return JSON.parse(out.join("")) as OwnerItem[];
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
