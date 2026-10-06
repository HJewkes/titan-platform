import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TABLE, type ActorClass, type PolicyTable } from "@titan-design/authority";
import {
  GatePayloadInvalid,
  GateResolverRefused,
  MemoryGateStore,
  type GateBrief,
  type GateInput,
  type GateRecord,
  type GateRule,
  type GateResolver,
  type GateStore,
} from "@titan-design/hitl";
import { SqliteGateStore, gateBriefMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunContext, type ContextDeps } from "./context.js";
import { mustacheRenderer } from "./prompt.js";
import { inlineRunner } from "./runners.js";
import type { WorkflowAuthorityOptions } from "./runtime-options.js";
import { WorkflowRuntime } from "./runtime.js";
import { parseSignal } from "./signals.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import {
  AuthorityDeniedError,
  AuthorityRefusedError,
  type AuthorizeOptions,
  type AuthorizeRequest,
  type AuthorizeResult,
  type WorkflowEvent,
  type WorkflowFn,
  type WorkflowRun,
} from "./types.js";

const SUBJECT = { repo: "example/widgets", pr: "7", headSha: "a1b2c3" };
const MERGE: AuthorizeRequest = { action: "merge", subject: SUBJECT };
const RELEASE: AuthorizeRequest = { action: "release", subject: { package: "@example/widgets", version: "1.2.0" } };
const STEP = "merge-authorize";
const OWNER_TERMINAL: GateResolver = { class: "owner-terminal", id: "owner", channel: "terminal" };
const OWNER_REMOTE: GateResolver = { class: "owner-remote", id: "owner", channel: "chat" };
const APPROVE = { decision: "approve", subject: SUBJECT };
const BRIEF: GateBrief = {
  summary: "Merge example/widgets#7 at a1b2c3? CI green. Recommend merge.",
  evidenceRef: "https://example.com/widgets/pull/7/checks",
  questions: [{ id: "decision", question: "Land this head?", options: [{ id: "merge", label: "Merge at a1b2c3", recommended: true }, { id: "abandon", label: "Abandon" }] }],
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(path = ":memory:"): Db {
  const db = openDatabase(path);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5), gateBriefMigration(6)]);
  return db;
}

function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-authorize-"));
  scratch.push(dir);
  return join(dir, "runs.db");
}

interface Harness {
  rt: WorkflowRuntime;
  gates: GateStore;
  events: WorkflowEvent[];
  results: AuthorizeResult[];
  errors: unknown[];
}

function harness(db: Db, actor: ActorClass, extra: { table?: PolicyTable; gates?: GateStore; request?: AuthorizeRequest; options?: AuthorizeOptions } = {}): Harness {
  const gates = extra.gates ?? new SqliteGateStore(db, { migrate: false });
  const events: WorkflowEvent[] = [];
  const results: AuthorizeResult[] = [];
  const errors: unknown[] = [];
  const authority: WorkflowAuthorityOptions = { actor: { class: actor, id: `${actor}-1` }, ...(extra.table ? { table: extra.table } : {}) };
  const rt = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused"), onEvent: (e) => events.push(e), gatePollMs: 5, authority });
  const flow: WorkflowFn = async (ctx) => {
    try {
      results.push(await ctx.authorize(STEP, extra.request ?? MERGE, extra.options));
    } catch (error) {
      errors.push(error);
      throw error;
    }
  };
  rt.register("governed", flow);
  return { rt, gates, events, results, errors };
}

async function pausedOnGate(h: Harness, runId: string): Promise<void> {
  await vi.waitFor(() => expect(h.rt.status(runId)?.status).toBe("paused"));
}

function gateOpenedCount(events: WorkflowEvent[]): number {
  return events.filter((event) => event.type === "gate_opened").length;
}

function withMergeByAutomationAllowed(): PolicyTable {
  const rules = DEFAULT_TABLE.rules.map((rule) =>
    rule.id === "MRG-AU" ? { id: rule.id, action: rule.action, actor: rule.actor, verdict: "allow" as const, evidence: rule.evidence } : rule,
  );
  return { version: "2.0.0", rules };
}

function replayContext(run: WorkflowRun, gates: GateStore, authority?: WorkflowAuthorityOptions): RunContext {
  const deps: ContextDeps = {
    gates,
    runner: inlineRunner(() => "unused"),
    render: mustacheRenderer,
    parseSignal,
    emit: () => undefined,
    maxRetries: 1,
    gatePollMs: 5,
    maxStepDataBytes: 65_536,
    executionId: () => "unused",
    save: () => undefined,
    recovered: new Map(),
    ...(authority ? { authority } : {}),
  };
  return new RunContext(structuredClone(run), deps, new AbortController());
}

/** A table whose every read throws, so a replay that consults the table fails loudly. */
const UNREADABLE_TABLE = new Proxy({} as PolicyTable, {
  get: () => {
    throw new Error("the table was consulted on replay");
  },
});

/** Stands in for an old or foreign writer: every gate it opened reads back resolved with no resolver. */
class AnonymousResolveStore implements GateStore {
  private readonly inner = new MemoryGateStore();
  create(input: GateInput): GateRecord {
    return this.inner.create(input);
  }
  get(id: string): GateRecord | undefined {
    const record = this.inner.get(id);
    return record && { ...record, status: "resolved", payload: APPROVE, resolvedAt: record.createdAt, resolvedBy: undefined };
  }
  resolve(id: string, payload: unknown, resolvedBy: GateResolver): GateRecord {
    return this.inner.resolve(id, payload, resolvedBy);
  }
  cancel(id: string, reason: string): GateRecord {
    return this.inner.cancel(id, reason);
  }
  listPending(): GateRecord[] {
    return this.inner.listPending();
  }
}

/** Reads back a resolved gate with the given answer and resolver, which the real stores would have refused to record. */
class ForgedResolveStore implements GateStore {
  private readonly inner = new MemoryGateStore();
  constructor(
    private readonly answer: unknown,
    private readonly resolvedBy: GateResolver,
  ) {}
  create(input: GateInput): GateRecord {
    return this.inner.create(input);
  }
  get(id: string): GateRecord | undefined {
    const record = this.inner.get(id);
    return record && { ...record, status: "resolved", payload: this.answer, resolvedAt: record.createdAt, resolvedBy: this.resolvedBy };
  }
  resolve(id: string, payload: unknown, resolvedBy: GateResolver): GateRecord {
    return this.inner.resolve(id, payload, resolvedBy);
  }
  cancel(id: string, reason: string): GateRecord {
    return this.inner.cancel(id, reason);
  }
  listPending(): GateRecord[] {
    return this.inner.listPending();
  }
}

/** Holds a resolved gate at whatever id is asked for, recorded under a rule the request does not map to. */
class ForeignRuleStore extends MemoryGateStore {
  override get(id: string): GateRecord | undefined {
    if (!super.get(id)) {
      super.create({ id, prompt: "approve?", rule: { table: "F5", version: "1.0.0", ruleId: "MRG-OTHER", resolvers: ["owner-terminal"] } });
      super.resolve(id, APPROVE, OWNER_TERMINAL);
    }
    return super.get(id);
  }
}

/** Holds a gate at whatever id is asked for, with the given rule (or none) and status. */
class SeededGateStore extends MemoryGateStore {
  constructor(
    private readonly rule: GateRule | undefined,
    private readonly resolved: boolean,
  ) {
    super();
  }
  override get(id: string): GateRecord | undefined {
    if (!super.get(id)) {
      super.create({ id, prompt: "approve?", ...(this.rule ? { rule: this.rule } : {}) });
      if (this.resolved) super.resolve(id, APPROVE, OWNER_TERMINAL);
    }
    return super.get(id);
  }
}

describe("ctx.authorize", () => {
  it("proceeds on an allow row without a gate, and replays the recorded result without the table", async () => {
    const h = harness(makeDb(), "automation", { request: RELEASE });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("completed");
    expect(h.results).toEqual([{ verdict: "allow", ruleId: "REL-AU" }]);
    expect(h.gates.listPending()).toEqual([]);
    const replay = replayContext(run, h.gates, { table: UNREADABLE_TABLE, actor: { class: "automation", id: "automation-1" } });
    await expect(replay.authorize(STEP, RELEASE)).resolves.toEqual({ verdict: "allow", ruleId: "REL-AU" });
  });

  it("fails the step on a deny row and opens no gate", async () => {
    const h = harness(makeDb(), "headless");

    const runId = h.rt.start("governed");
    const run = await h.rt.wait(runId);

    expect(run.status).toBe("failed");
    expect(h.errors[0]).toBeInstanceOf(AuthorityDeniedError);
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-HD", retryable: false });
    expect(h.gates.listPending()).toEqual([]);
    expect(h.gates.get(`${runId}/${STEP}`)).toBeUndefined();
    expect(gateOpenedCount(h.events)).toBe(0);
    expect(h.events).toContainEqual({ type: "step_failed", runId, stepId: STEP, error: expect.stringContaining("authority denied") });
  });

  it("opens a gate bound to the rule and its resolvers, and proceeds on an owner's approval", async () => {
    const h = harness(makeDb(), "automation");
    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    expect(h.gates.get(`${runId}/${STEP}`)?.rule).toEqual({ table: "F5", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
    h.rt.signal(runId, STEP, APPROVE, OWNER_REMOTE);

    expect((await h.rt.wait(runId)).status).toBe("completed");
    expect(h.results).toEqual([{ verdict: "approved", ruleId: "MRG-AU", gateId: `${runId}/${STEP}`, resolvedBy: OWNER_REMOTE }]);
  });

  it("an authorize gate carries the brief given in options", async () => {
    const h = harness(makeDb(), "automation", { options: { brief: BRIEF } });

    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    expect(h.gates.get(`${runId}/${STEP}`)).toMatchObject({ rule: { ruleId: "MRG-AU" }, ...BRIEF });
    h.rt.shutdown();
  });

  it("a brief carrying extra rule and id keys leaves the gate's id and authority rule unchanged", async () => {
    const rogue = { ...BRIEF, rule: { table: "F5", version: "9", ruleId: "FAKE", resolvers: ["automation"] }, id: "other" };
    const h = harness(makeDb(), "automation", { options: { brief: rogue } });

    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    expect(h.gates.get("other")).toBeUndefined();
    expect(h.gates.get(`${runId}/${STEP}`)).toMatchObject({ rule: { ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] }, ...BRIEF });
    h.rt.shutdown();
  });

  it("an authorize gate's gate_opened carries the summary", async () => {
    const h = harness(makeDb(), "automation", { options: { brief: BRIEF } });

    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    expect(h.events.find((event) => event.type === "gate_opened")).toMatchObject({ gateId: `${runId}/${STEP}`, summary: BRIEF.summary });
    h.rt.shutdown();
  });

  it("resumes onto the same gate id after a kill and restart", async () => {
    const file = scratchFile();
    const first = harness(makeDb(file), "automation");
    const runId = first.rt.start("governed");
    await pausedOnGate(first, runId);
    first.rt.shutdown();

    const second = harness(makeDb(file), "automation");
    expect(await second.rt.hydrate()).toEqual([runId]);
    await pausedOnGate(second, runId);

    expect(second.gates.listPending().map((gate) => gate.id)).toEqual([`${runId}/${STEP}`]);
    expect(gateOpenedCount(second.events)).toBe(0);
    second.rt.signal(runId, STEP, APPROVE, OWNER_TERMINAL);
    expect((await second.rt.wait(runId)).status).toBe("completed");
    expect(second.results).toEqual([{ verdict: "approved", ruleId: "MRG-AU", gateId: `${runId}/${STEP}`, resolvedBy: OWNER_TERMINAL }]);
  });

  it("holds the run for recovery instead of deciding again when the paused gate's row is gone", async () => {
    const file = scratchFile();
    const first = harness(makeDb(file), "automation");
    const runId = first.rt.start("governed");
    await pausedOnGate(first, runId);
    first.rt.shutdown();
    const db = makeDb(file);
    db.prepare(`DELETE FROM "hitl_gate" WHERE id = ?`).run(`${runId}/${STEP}`);

    const second = harness(db, "automation");
    await second.rt.hydrate();
    const run = await second.rt.wait(runId);

    expect(run.status).toBe("recovery_required");
    expect(second.events).toContainEqual(expect.objectContaining({ type: "workflow_recovery_required", gateId: `${runId}/${STEP}` }));
    expect(gateOpenedCount(second.events)).toBe(0);
    expect(second.gates.get(`${runId}/${STEP}`)).toBeUndefined();
  });

  it("keeps the gated decision when the table changes during the pause", async () => {
    const file = scratchFile();
    const first = harness(makeDb(file), "automation");
    const runId = first.rt.start("governed");
    await pausedOnGate(first, runId);
    first.rt.shutdown();

    const second = harness(makeDb(file), "automation", { table: withMergeByAutomationAllowed() });
    await second.rt.hydrate();
    await pausedOnGate(second, runId);

    expect(second.results).toEqual([]);
    expect(second.gates.get(`${runId}/${STEP}`)?.status).toBe("pending");
    second.rt.signal(runId, STEP, APPROVE, OWNER_TERMINAL);
    expect((await second.rt.wait(runId)).status).toBe("completed");
    expect(second.results).toEqual([expect.objectContaining({ verdict: "approved", ruleId: "MRG-AU" })]);
  });

  it("refuses owner-remote on a REL-CO gate and leaves the run paused", async () => {
    const h = harness(makeDb(), "coordinator", { request: RELEASE });
    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    expect(h.gates.get(`${runId}/${STEP}`)?.rule?.resolvers).toEqual(["owner-terminal"]);
    expect(() => h.rt.signal(runId, STEP, { decision: "approve", subject: RELEASE.subject }, OWNER_REMOTE)).toThrow(GateResolverRefused);

    expect(h.gates.get(`${runId}/${STEP}`)).toMatchObject({ status: "pending", resolvedBy: undefined });
    expect(h.rt.status(runId)?.status).toBe("paused");
    h.rt.shutdown();
  });

  it("fails the step when the gate reads back resolved with no resolver, and replay throws the same", async () => {
    const gates = new AnonymousResolveStore();
    const h = harness(makeDb(), "automation", { gates });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.errors[0]).toBeInstanceOf(AuthorityRefusedError);
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-AU", refusal: "the gate was resolved without a resolver" });
    await expect(replayContext(run, gates).authorize(STEP, MERGE)).rejects.toBeInstanceOf(AuthorityRefusedError);
  });

  it("refuses an answer whose subject echo does not match the request, and the gate stays pending", async () => {
    const h = harness(makeDb(), "automation");
    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    const mismatched = { decision: "approve", subject: { ...SUBJECT, headSha: "d4e5f6" } };
    expect(() => h.rt.signal(runId, STEP, mismatched, OWNER_TERMINAL)).toThrow(GatePayloadInvalid);

    expect(h.gates.get(`${runId}/${STEP}`)?.status).toBe("pending");
    expect(h.rt.status(runId)?.status).toBe("paused");
    h.rt.shutdown();
  });

  it("fails the step with the owner's reason on a refuse answer", async () => {
    const h = harness(makeDb(), "automation");
    const runId = h.rt.start("governed");
    await pausedOnGate(h, runId);

    h.rt.signal(runId, STEP, { decision: "refuse", subject: SUBJECT, reason: "wrong branch" }, OWNER_TERMINAL);

    expect(await h.rt.wait(runId)).toMatchObject({ status: "failed", error: expect.stringContaining("owner refused: wrong branch") });
    expect(h.errors[0]).toBeInstanceOf(AuthorityRefusedError);
  });

  it("fails at the first authorize, before any gate, when the runtime has no authority option", async () => {
    const db = makeDb();
    const gates = new SqliteGateStore(db, { migrate: false });
    const rt = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused"), gatePollMs: 5 });
    rt.register("governed", async (ctx) => void (await ctx.authorize(STEP, MERGE)));

    const run = await rt.wait(rt.start("governed"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("needs the runtime's authority option") });
    expect(gates.listPending()).toEqual([]);
  });

  it("refuses a pre-existing gate recorded under a different rule than the request maps to", async () => {
    const gates = new ForeignRuleStore();
    const h = harness(makeDb(), "automation", { gates });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.results).toEqual([]);
    expect(h.errors[0]).toBeInstanceOf(AuthorityRefusedError);
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-OTHER", refusal: expect.stringContaining("MRG-AU") });
  });

  it("refuses a resolved record whose resolver class the rule does not allow, even if a store recorded it", async () => {
    const gates = new ForgedResolveStore(APPROVE, { class: "automation", id: "bot", channel: "chat" });
    const h = harness(makeDb(), "automation", { gates });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-AU", refusal: expect.stringContaining("does not let automation resolve") });
  });

  it("refuses a resolved record whose subject echo differs from the request, even if a store recorded it", async () => {
    const answer = { decision: "approve", subject: { ...SUBJECT, headSha: "d4e5f6" } };
    const gates = new ForgedResolveStore(answer, OWNER_TERMINAL);
    const h = harness(makeDb(), "automation", { gates });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-AU", refusal: "the answer does not echo the request's subject" });
  });

  it("refuses a resolved gate that carries no rule, never approving it", async () => {
    const h = harness(makeDb(), "automation", { gates: new SeededGateStore(undefined, true) });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.results).toEqual([]);
    expect(h.errors[0]).toBeInstanceOf(AuthorityRefusedError);
    expect(h.errors[0]).toMatchObject({ ruleId: "unbound", refusal: "the gate carries no authority rule" });
  });

  it("refuses a pending gate that carries no rule at once, without pausing", async () => {
    const h = harness(makeDb(), "automation", { gates: new SeededGateStore(undefined, false) });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.errors[0]).toMatchObject({ ruleId: "unbound", refusal: "the gate carries no authority rule" });
  });

  it("refuses a gate recorded under another table even when its ruleId matches", async () => {
    const rule: GateRule = { table: "OTHER", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal"] };
    const h = harness(makeDb(), "automation", { gates: new SeededGateStore(rule, true) });

    const run = await h.rt.wait(h.rt.start("governed"));

    expect(run.status).toBe("failed");
    expect(h.results).toEqual([]);
    expect(h.errors[0]).toMatchObject({ ruleId: "MRG-AU", refusal: expect.stringContaining("table OTHER") });
  });
});
