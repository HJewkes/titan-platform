import { MemoryGateStore, type GateStore } from "@titan-design/hitl";
import type { MatrixEvent } from "@titan-design/matrix-bus";
import { describe, expect, it } from "vitest";
import { FakeHub } from "./fake-hub.js";
import { hitlQueueSource } from "./hitl.js";
import { MemoryMirrorState } from "./memory-state.js";
import { createMirror } from "./mirror.js";
import type { SourceEvent } from "./types.js";

const OWNER = "@owner:hub.test";
const ANSWER_SCHEMA = { type: "object", properties: { pick: { type: "string" } }, required: ["pick"] };

let seq = 0;
const reaction = (target: string, key: string): MatrixEvent => ({
  type: "m.reaction",
  event_id: `$r${++seq}`,
  sender: OWNER,
  content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
});
const reply = (target: string, body: string): MatrixEvent => ({
  type: "m.room.message",
  event_id: `$m${++seq}`,
  sender: OWNER,
  content: { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: target } } },
});

async function rig(clock = { now: Date.parse("2026-09-23T12:00:00Z") }) {
  const store = new MemoryGateStore({ now: () => clock.now });
  const source = hitlQueueSource(store, { machine: "edge1", session: "ff-daemon", pollMs: 1 });
  const hub = new FakeHub();
  const state = new MemoryMirrorState();
  const mirror = createMirror(source, hub, state, { ownerUserId: OWNER, roomId: "!q:hub.test", signal: new AbortController().signal });
  return { store, source, hub, state, mirror, clock };
}

async function next(events: AsyncIterator<SourceEvent>): Promise<SourceEvent | undefined> {
  return (await events.next()).value;
}

describe("hitlQueueSource with the mirror", () => {
  it("round-trips a pending gate to resolved {approved: true} on an owner ✅ and edits the item", async () => {
    const { store, hub, state, mirror } = await rig();
    const gate = store.create({ prompt: "draft Bijan Robinson?" });

    await mirror.reconcile();
    await mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "✅")));

    expect(store.get(gate.id)).toMatchObject({ status: "resolved", payload: { approved: true } });
    expect(state.bySourceId(gate.id)).toMatchObject({ kind: "approval_request", status: "closed" });
    expect(hub.edits()).toHaveLength(1);
  });

  it("cancels on ❌ with the reason", async () => {
    const { store, hub, state, mirror } = await rig();
    const gate = store.create({ prompt: "trade?" });
    await mirror.reconcile();

    await mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "❌")));

    expect(store.get(gate.id)).toMatchObject({ status: "cancelled", reason: "denied from Matrix" });
  });

  it("rejects an answer the gate's schema refuses and leaves the gate pending", async () => {
    const { store, hub, state, mirror } = await rig();
    const gate = store.create({ prompt: "which player?", schema: ANSWER_SCHEMA });
    await mirror.reconcile();

    await mirror.applySyncBatch(hub.deliver(reply(state.bySourceId(gate.id)!.eventId, "Bijan")));

    expect(state.bySourceId(gate.id)).toMatchObject({ kind: "question", status: "open" });
    expect(store.get(gate.id)?.status).toBe("pending");
  });

  it("reports closed for a gate settled at the terminal", async () => {
    const { store, source } = await rig();
    const gate = store.create({ prompt: "go?" });
    store.resolve(gate.id, "from the terminal");

    expect(await source.resolve(gate.id, { verdict: "allow", resolutionEventId: "$x" })).toEqual({ ok: false, reason: "closed" });
  });

  it("maps a hitl error to closed by name, not instanceof", async () => {
    const store = new MemoryGateStore();
    const gate = store.create({ prompt: "go?" });
    const foreign = Object.assign(new Error("gate is already resolved"), { name: "GateAlreadySettled" });
    const throwing: GateStore = {
      create: (input) => store.create(input),
      get: (id) => store.get(id),
      listPending: () => store.listPending(),
      cancel: (id, reason) => store.cancel(id, reason),
      resolve: () => {
        throw foreign;
      },
    };
    const source = hitlQueueSource(throwing, { machine: "m", session: "s" });

    expect(await source.resolve(gate.id, { verdict: "allow", resolutionEventId: "$x" })).toMatchObject({ ok: false, reason: "closed" });
  });

  it("tails opened gates, then closed/expired once the clock passes expiresAt", async () => {
    const { store, source, clock } = await rig();
    const gate = store.create({ prompt: "soon", expiresAt: new Date(clock.now + 1_000) });
    const controller = new AbortController();
    const events = source.tail(undefined, controller.signal)[Symbol.asyncIterator]();

    const opened = await next(events);
    clock.now += 1_000;
    const closed = await next(events);
    controller.abort();

    expect(opened).toMatchObject({ type: "opened", item: { id: gate.id, expiresAt: clock.now } });
    expect(closed).toMatchObject({ type: "closed", id: gate.id, outcome: "expired" });
  });
});
