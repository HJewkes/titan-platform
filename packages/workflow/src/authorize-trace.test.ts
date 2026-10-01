import { POLICY_GATE_ID_PATTERN, TraceGateSchema, policyGateId } from "@titan-design/agent-protocol/trace";
import type { ActorClass, PolicyTable } from "@titan-design/authority";
import { SqliteGateStore, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { TRACE_GATES_KEY } from "./index.js";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { AuthorizeRequest, WorkflowFn, WorkflowRun } from "./types.js";

const SUBJECT = { repo: "example/widgets", pr: "7", headSha: "a1b2c3" };
const MERGE: AuthorizeRequest = { action: "merge", subject: SUBJECT };
const STEP = "merge-authorize";
const OWNER = { class: "owner-terminal" as const, id: "owner", channel: "terminal" };

function runtime(actor: ActorClass, table?: PolicyTable) {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5)]);
  const gates = new SqliteGateStore(db, { migrate: false });
  const rt = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused"), gatePollMs: 5, authority: { actor: { class: actor, id: `${actor}-1` }, ...(table ? { table } : {}) } });
  return { rt, gates };
}

function authorizeFlow(request: AuthorizeRequest): WorkflowFn {
  return async (ctx) => {
    await ctx.authorize(STEP, request).catch(() => undefined);
  };
}

function gateRecords(run: WorkflowRun): unknown[] {
  return run.stepResults[STEP]!.data?.[TRACE_GATES_KEY] as unknown[];
}

describe("authorize writes F3 policy gate records", () => {
  it("records an allow decision that parses strict, under an id from policyGateId", async () => {
    const { rt } = runtime("owner-terminal");
    rt.register("flow", authorizeFlow({ action: "release", subject: { package: "@example/widgets", version: "1.2.0" } }));
    const run = await rt.wait(rt.start("flow"));
    const [record] = gateRecords(run);
    expect(TraceGateSchema.parse(record)).toMatchObject({ gateKind: "policy", verdict: "allow", decidedBy: "policy:F5", policyRule: { table: "F5", rowId: "REL-OT", version: 1 } });
    expect((record as { id: string }).id).toMatch(POLICY_GATE_ID_PATTERN);
    expect((record as { id: string }).id).toBe(policyGateId(`workflow:${run.id}:${STEP}:0:0`, "F5", "REL-OT"));
  });

  it("records a gate decision with a null verdict once the owner approves", async () => {
    const { rt, gates } = runtime("automation");
    rt.register("flow", authorizeFlow(MERGE));
    const runId = rt.start("flow");
    await vi.waitFor(() => expect(gates.listPending()).toHaveLength(1));
    rt.signal(runId, STEP, { decision: "approve", subject: SUBJECT }, OWNER);
    const [record] = gateRecords(await rt.wait(runId));
    expect(TraceGateSchema.parse(record)).toMatchObject({ verdict: null, policyRule: { rowId: "MRG-AU" } });
  });

  it("records a deny decision that parses strict", async () => {
    const { rt } = runtime("headless");
    rt.register("flow", authorizeFlow(MERGE));
    const [record] = gateRecords(await rt.wait(rt.start("flow")));
    expect(TraceGateSchema.parse(record)).toMatchObject({ verdict: "deny", policyRule: { rowId: "MRG-HD" } });
  });

  it("records row id no-rule when a deny names no rule", async () => {
    const { rt } = runtime("owner-terminal", { version: "3.1.0", rules: [] });
    rt.register("flow", authorizeFlow(MERGE));
    const [record] = gateRecords(await rt.wait(rt.start("flow")));
    expect(TraceGateSchema.parse(record)).toMatchObject({ verdict: "deny", policyRule: { rowId: "no-rule", version: 3 } });
  });
});
