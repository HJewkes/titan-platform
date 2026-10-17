import { afterEach, describe, expect, it } from "vitest";
import type { AnswersPage, AskRequest, ServiceAnswer } from "@titan-design/agent-dispatch";
import type { GateRecord, GateRule } from "@titan-design/hitl";
import { toJSONSchema } from "zod";
import { approveMergeDecision, frozenDecision } from "./gate-brief.js";
import { askable, answerPayload, notifyTick, type GateNotifyPorts } from "./gate-notify.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { OWNER } from "./test-support/resolver.js";
import { tableGateRule } from "./workflows/land-approval.js";

const HEAD = "a".repeat(40);
const GATE = "run1/approve-merge";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** agent-chat's log as the broker keeps it: asks and answers share one ordered id space, and `since` reads after an id. */
class FakeQueue {
  readonly asked: AskRequest[] = [];
  readonly dismissed: string[] = [];
  private readonly log: string[] = [];
  private readonly answers: ServiceAnswer[] = [];

  ask(req: AskRequest): string {
    this.asked.push(req);
    return this.append(`q${this.log.length + 1}`);
  }

  answer(questionId: string, text: string, outcome: ServiceAnswer["outcome"] = "answered"): void {
    const msgId = this.append(`a${this.log.length + 1}`);
    this.answers.push({ msgId, questionId, outcome, text, by: "human", channel: "phone", at: this.log.length });
  }

  read(since: string | undefined): AnswersPage {
    const from = since === undefined ? -1 : this.log.indexOf(since);
    const answers = this.answers.filter((answer) => this.log.indexOf(answer.msgId) > from);
    const last = answers.at(-1)?.msgId;
    return { answers, ...(last !== undefined && { next: last }) };
  }

  private append(id: string): string {
    this.log.push(id);
    return id;
  }
}

function host(): FactoryHost {
  const opened = openFactoryHost({ dbPath: ":memory:", workflows: [], routes: [] });
  hosts.push(opened);
  return opened;
}

function openMergeGate(target: FactoryHost, id = GATE, sendBack = false, rule?: GateRule): void {
  const { schema, brief } = approveMergeDecision({ repo: "HJewkes/demo", pr: 7, headSha: HEAD, reason: "Ready.", reviewedMerge: true, sendBack });
  target.gates.create({ id, prompt: "Merge?", schema: toJSONSchema(schema), ...brief, ...(rule && { rule }) });
}

function ports(target: FactoryHost, queue: FakeQueue, logs: string[] = []): GateNotifyPorts {
  return {
    label: "titan-factory",
    resolverClass: "owner-remote",
    pendingGates: () => target.gates.listPending(),
    getGate: (id) => target.gates.get(id),
    resolve: (id, payload, resolver) => void target.gates.resolve(id, payload, resolver),
    asks: target.asks,
    askHuman: async (req) => queue.ask(req),
    readAnswers: async (_label, since) => queue.read(since),
    dismissAsk: async (msgId) => void queue.dismissed.push(msgId),
    log: (line) => void logs.push(line),
  };
}

describe("gate notify: exactly once", () => {
  it("asks a decision gate once and resolves it from one answer with the configured resolver", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory);

    await notifyTick(ports(factory, queue));
    await notifyTick(ports(factory, queue));
    queue.answer("q1", " Merge ");
    await notifyTick(ports(factory, queue));

    expect(queue.asked).toEqual([expect.objectContaining({ as: "titan-factory", task: `gate:${GATE}`, options: ["merge", "abandon"], recommended: "merge" })]);
    expect(queue.asked[0]?.text).toContain("https://github.com/HJewkes/demo/pull/7");
    expect(factory.gates.get(GATE)).toMatchObject({
      status: "resolved",
      payload: { decision: "merge", headSha: HEAD },
      resolvedBy: { class: "owner-remote", id: "agent-chat", channel: "agent-chat:phone" },
    });
  });

  it("leaves one resolution when the page is replayed or the cursor is reset to the question", async () => {
    const factory = host();
    const queue = new FakeQueue();
    const logs: string[] = [];
    openMergeGate(factory);
    await notifyTick(ports(factory, queue, logs));
    queue.answer("q1", "merge");
    await notifyTick(ports(factory, queue, logs));
    const first = factory.gates.get(GATE)?.resolvedAt;

    factory.asks.advance("titan-factory", "q1");
    await notifyTick(ports(factory, queue, logs));
    const replay = { ...ports(factory, queue, logs), readAnswers: async () => queue.read(undefined) };
    await notifyTick(replay);

    expect(factory.gates.get(GATE)?.resolvedAt).toBe(first);
    expect(factory.asks.get(GATE)?.state).toBe("resolved");
    expect(queue.dismissed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("withdraws the ask when the gate is resolved at the terminal first, and ignores the late answer", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory);
    await notifyTick(ports(factory, queue));
    factory.gates.resolve(GATE, { decision: "abandon", headSha: HEAD }, OWNER);

    await notifyTick(ports(factory, queue));
    queue.answer("q1", "merge");
    await notifyTick(ports(factory, queue));

    expect(queue.dismissed).toEqual(["q1"]);
    expect(factory.asks.get(GATE)?.state).toBe("withdrawn");
    expect(factory.gates.get(GATE)).toMatchObject({ payload: { decision: "abandon" }, resolvedBy: OWNER });
  });

  it("withdraws, without throwing, an answer whose gate the terminal settled after the tick read it as pending", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory);
    await notifyTick(ports(factory, queue));
    const readBeforeTheTerminal = factory.gates.get(GATE);
    factory.gates.resolve(GATE, { decision: "abandon", headSha: HEAD }, OWNER);
    const raced = { ...ports(factory, queue), getGate: () => readBeforeTheTerminal };
    queue.answer("q1", "merge");

    await notifyTick(raced);

    expect(factory.asks.get(GATE)?.state).toBe("withdrawn");
    expect(factory.gates.get(GATE)?.payload).toEqual({ decision: "abandon", headSha: HEAD });
  });
});

describe("gate notify: answers that do not resolve", () => {
  it("a dismissal leaves the gate pending and closes the ask", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory);
    await notifyTick(ports(factory, queue));

    queue.answer("q1", "", "dismissed");
    await notifyTick(ports(factory, queue));

    expect(factory.gates.get(GATE)?.status).toBe("pending");
    expect(factory.asks.get(GATE)?.state).toBe("dismissed");
  });

  it("an answer naming no option leaves the gate pending and keeps the text", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory);
    await notifyTick(ports(factory, queue));

    queue.answer("q1", "maybe");
    await notifyTick(ports(factory, queue));

    expect(factory.gates.get(GATE)?.status).toBe("pending");
    expect(factory.asks.get(GATE)).toMatchObject({ state: "unmappable", detail: "maybe" });
  });

  it("a failed ask leaves no row, so the next tick asks again", async () => {
    const factory = host();
    const queue = new FakeQueue();
    const logs: string[] = [];
    openMergeGate(factory);
    const refusing = { ...ports(factory, queue, logs), askHuman: () => Promise.reject(new Error("titan-factory already has 20 open questions")) };

    await notifyTick(refusing);
    await notifyTick(ports(factory, queue));

    expect(logs).toEqual([`gate notify: could not ask ${GATE}: titan-factory already has 20 open questions`]);
    expect(queue.asked).toHaveLength(1);
  });

  it("an unexpected resolve fault keeps the ask open and the cursor in place, so the answer is read again", async () => {
    const factory = host();
    const queue = new FakeQueue();
    const logs: string[] = [];
    openMergeGate(factory);
    await notifyTick(ports(factory, queue));
    queue.answer("q1", "merge");
    const faulty = {
      ...ports(factory, queue, logs),
      resolve: () => {
        throw new Error("database is locked");
      },
    };

    await notifyTick(faulty);
    await notifyTick(ports(factory, queue));

    expect(logs).toEqual([`gate notify: could not resolve ${GATE}: database is locked`]);
    expect(factory.gates.get(GATE)?.status).toBe("resolved");
  });
});

describe("which gates are asked", () => {
  const merge = approveMergeDecision({ repo: "HJewkes/demo", pr: 7, headSha: HEAD, reason: "Ready.", reviewedMerge: true });
  const gate = (overrides: Partial<GateRecord> = {}): GateRecord => ({
    id: GATE,
    prompt: "Merge?",
    schema: toJSONSchema(merge.schema),
    status: "pending",
    payload: undefined,
    reason: undefined,
    createdAt: "2026-10-11T12:00:00.000Z",
    resolvedAt: undefined,
    expiresAt: undefined,
    resolvedBy: undefined,
    resolvedEvidence: undefined,
    rule: undefined,
    summary: merge.brief.summary,
    evidenceRef: merge.brief.evidenceRef,
    questions: merge.brief.questions,
    ...overrides,
  });
  const rule = (resolvers: GateRule["resolvers"]): GateRule => ({ table: "default", version: "1", ruleId: "MRG-CO", resolvers });

  it("never asks a gate whose rule admits only the terminal", () => {
    expect(askable(gate({ rule: rule(["owner-terminal"]) }), "owner-remote")).toBe(false);
    expect(askable(gate({ rule: rule(["owner-terminal", "owner-remote"]) }), "owner-remote")).toBe(true);
  });

  it("never asks a gate whose answer needs a field the question does not pin", () => {
    const frozen = frozenDecision({ repo: "HJewkes/demo", mergeSha: HEAD, situation: "Main is red." });
    const schema = toJSONSchema(frozen.schema) as Record<string, unknown>;

    expect(askable(gate({ schema, questions: frozen.brief.questions }), "owner-remote")).toBe(false);
  });

  it("never asks a gate without the one decision question", () => {
    expect(askable(gate({ questions: undefined }), "owner-remote")).toBe(false);
  });

  it("maps an option's label as well as its id, and nothing else", () => {
    expect(answerPayload(gate(), "merge at this head")).toEqual({ decision: "merge", headSha: HEAD });
    expect(answerPayload(gate(), "yes")).toBeUndefined();
  });
});

describe("gate notify: gates land stamped with their table row", () => {
  it("asks and resolves a gate stamped with the MRG-AU row, which names owner-remote", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory, GATE, false, tableGateRule({ table: "authority", rowId: "MRG-AU", version: 1 }));

    await notifyTick(ports(factory, queue));
    queue.answer("q1", "merge");
    await notifyTick(ports(factory, queue));

    expect(queue.asked).toHaveLength(1);
    expect(factory.gates.get(GATE)).toMatchObject({ status: "resolved", rule: { ruleId: "MRG-AU" }, resolvedBy: { class: "owner-remote" } });
  });

  it("never asks a release gate, which REL-CO leaves to owner-terminal", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory, GATE, false, tableGateRule({ table: "shepherd-release", rowId: "owner-gate", version: 1 }));

    await notifyTick(ports(factory, queue));

    expect(queue.asked).toEqual([]);
    expect(factory.gates.get(GATE)).toMatchObject({ status: "pending", rule: { ruleId: "REL-CO", resolvers: ["owner-terminal"] } });
  });
});

describe("gate notify: an approve-merge gate that offers send-back", () => {
  it("leaves a send-back answer unmappable, since an option alone carries no note", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory, GATE, true);
    await notifyTick(ports(factory, queue));

    queue.answer("q1", "send-back");
    await notifyTick(ports(factory, queue));

    expect(queue.asked[0]?.options).toEqual(["merge", "abandon", "send-back"]);
    expect(factory.gates.get(GATE)?.status).toBe("pending");
    expect(factory.asks.get(GATE)).toMatchObject({ state: "unmappable", detail: expect.stringContaining("does not match its schema") });
  });

  it("still resolves a merge answer at the pinned head", async () => {
    const factory = host();
    const queue = new FakeQueue();
    openMergeGate(factory, GATE, true);
    await notifyTick(ports(factory, queue));

    queue.answer("q1", "merge");
    await notifyTick(ports(factory, queue));

    expect(factory.gates.get(GATE)).toMatchObject({ status: "resolved", payload: { decision: "merge", headSha: HEAD } });
  });
});
