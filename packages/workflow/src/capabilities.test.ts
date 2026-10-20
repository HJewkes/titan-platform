import { SqliteGateStore, gateBriefMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowEvent, WorkflowFn } from "./types.js";

const SENTINEL = "sentinel-capability-value-0001";
const HANDLE = { token: SENTINEL, call: () => "ok" };
const CAPABILITIES = { "github-bot": { handle: HANDLE, secrets: [SENTINEL] } };

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5), gateBriefMigration(6)]);
  return db;
}

function callThrough(handle: unknown): string {
  return handle === HANDLE ? HANDLE.call() : "wrong handle";
}

function tokenOf(handle: unknown): string {
  return handle === HANDLE ? HANDLE.token : "wrong handle";
}

interface Harness {
  db: Db;
  rt: WorkflowRuntime;
  events: WorkflowEvent[];
  prompts: string[];
}

function harness(output = "agent says hi"): Harness {
  const db = makeDb();
  const events: WorkflowEvent[] = [];
  const prompts: string[] = [];
  const runner = inlineRunner((input) => {
    prompts.push(input.prompt);
    return output;
  });
  const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, onEvent: (e) => events.push(e), gatePollMs: 5, capabilities: CAPABILITIES });
  return { db, rt, events, prompts };
}

async function finished(h: Harness, flow: WorkflowFn): Promise<string> {
  h.rt.register("flow", flow);
  const runId = h.rt.start("flow");
  await vi.waitFor(() => expect(["completed", "failed"]).toContain(h.rt.status(runId)?.status));
  return runId;
}

function everythingStored(h: Harness, runId: string): string {
  const rows = h.db.prepare("SELECT * FROM workflow_run").all();
  return JSON.stringify({ rows, status: h.rt.status(runId), events: h.events });
}

describe("ctx.capability", () => {
  it("hands the step body the configured handle", async () => {
    const h = harness();
    let seen: unknown;

    await finished(h, async (ctx) => void (seen = callThrough(ctx.capability("github-bot"))));

    expect(seen).toBe("ok");
    h.rt.shutdown();
  });

  it("an unconfigured name fails the run without naming any secret", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void ctx.capability("missing"));

    expect(h.rt.status(runId)).toMatchObject({ status: "failed", error: "unknown capability: missing" });
    h.rt.shutdown();
  });

  it("a seed that uses the capability and returns clean data leaves the sentinel out of every record", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => {
      await ctx.seed("use", async () => ({ data: { used: callThrough(ctx.capability("github-bot")) }, output: "done" }));
      await ctx.dispatch("ask", "hello {{used}}");
    });

    expect(h.rt.status(runId)?.status).toBe("completed");
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    expect(h.prompts).toEqual(["hello ok"]);
    h.rt.shutdown();
  });
});

describe("a step that would leak the capability", () => {
  it("a seed returning it in data is refused and records nothing", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.seed("leak", async () => ({ data: { t: tokenOf(ctx.capability("github-bot")) } }))));

    expect(h.rt.status(runId)).toMatchObject({ status: "failed", error: "capability secret refused in leak result", stepResults: {} });
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("a seed returning it in output is refused", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.seed("leak", async () => ({ data: {}, output: `token ${SENTINEL}` }))));

    expect(h.rt.status(runId)?.status).toBe("failed");
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("a seed throwing it in its message fails the run with the secret redacted", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.seed("leak", async () => { throw new Error(`auth failed for ${SENTINEL}`); })));

    expect(h.rt.status(runId)?.status).toBe("failed");
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("a workflow throwing it outside a seed has it redacted from the run error and events", async () => {
    const h = harness();

    const runId = await finished(h, async () => { throw new Error(`boom ${SENTINEL}`); });

    expect(h.rt.status(runId)).toMatchObject({ status: "failed", error: "boom [redacted]" });
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("a dispatch templating it through vars never renders or runs the prompt", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.dispatch("ask", "key {{k}}", { vars: { k: tokenOf(ctx.capability("github-bot")) } })));

    expect(h.rt.status(runId)).toMatchObject({ status: "failed", error: "capability secret refused in ask prompt vars" });
    expect(h.prompts).toEqual([]);
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("a template that already holds it is refused after rendering", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.dispatch("ask", `inline ${SENTINEL}`)));

    expect(h.rt.status(runId)?.status).toBe("failed");
    expect(h.prompts).toEqual([]);
    h.rt.shutdown();
  });

  it("an agent output echoing it is refused and not recorded", async () => {
    const h = harness(`here: ${SENTINEL}`);

    const runId = await finished(h, async (ctx) => void (await ctx.dispatch("ask", "go")));

    expect(h.rt.status(runId)).toMatchObject({ status: "failed", stepResults: {}, activeSteps: {} });
    expect(everythingStored(h, runId)).not.toContain(SENTINEL);
    h.rt.shutdown();
  });

  it("an assisted prompt carrying it opens no gate", async () => {
    const h = harness();

    const runId = await finished(h, async (ctx) => void (await ctx.assisted("ask", `use ${SENTINEL}`)));

    expect(h.rt.status(runId)?.status).toBe("failed");
    expect(h.db.prepare("SELECT count(*) AS n FROM hitl_gate").get()).toEqual({ n: 0 });
    h.rt.shutdown();
  });

  it("a JSON-escaped form of the secret is caught too", async () => {
    const quoted = 'sec"ret-value-0002';
    const db = makeDb();
    const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: inlineRunner(() => "x"), capabilities: { c: { handle: 1, secrets: [quoted] } } });
    rt.register("flow", async (ctx) => void (await ctx.seed("s", async () => ({ data: {}, output: JSON.stringify({ v: quoted }) }))));

    const runId = rt.start("flow");
    await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("failed"));

    rt.shutdown();
  });
});

describe("capability configuration", () => {
  it("an empty secret is rejected at construction", () => {
    const db = makeDb();

    expect(() => new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: inlineRunner(() => "x"), capabilities: { c: { handle: 1, secrets: [""] } } })).toThrow(/non-empty/);
  });
});
