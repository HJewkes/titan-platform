import { GateStoreSchemaOutdated, MemoryGateStore, type GateAuthorize, type GateStore } from "@titan-design/hitl";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import type { MatrixEvent } from "@titan-design/matrix-bus";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHub } from "./fake-hub.js";
import { hitlQueueSource } from "./hitl.js";
import { MemoryMirrorState } from "./memory-state.js";
import { createMirror } from "./mirror.js";
import type { SourceEvent } from "./types.js";

const OWNER = "@owner:example.org";
const STRANGER = "@stranger:example.org";
const ANSWER_SCHEMA = { type: "object", properties: { pick: { type: "string" } }, required: ["pick"] };

let seq = 0;
const reaction = (target: string, key: string, sender = OWNER): MatrixEvent => ({
  type: "m.reaction",
  event_id: `$r${++seq}`,
  sender,
  content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
});
const reply = (target: string, body: string): MatrixEvent => ({
  type: "m.room.message",
  event_id: `$m${++seq}`,
  sender: OWNER,
  content: { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: target } } },
});

async function rig(clock = { now: Date.parse("2026-09-23T12:00:00Z") }, store: GateStore = new MemoryGateStore({ now: () => clock.now })) {
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
    store.resolve(gate.id, "from the terminal", { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" });

    expect(await source.resolve(gate.id, { verdict: "allow", resolutionEventId: "$x", sender: OWNER })).toEqual({ ok: false, reason: "closed" });
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

    expect(await source.resolve(gate.id, { verdict: "allow", resolutionEventId: "$x", sender: OWNER })).toMatchObject({ ok: false, reason: "closed" });
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

function migratedGateFile(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "qm-hitl-")), "gates.db");
  runMigrations(openDatabase(file), [gateMigration(1), gateResolverMigration(2)]);
  return file;
}

const refuseAll: GateAuthorize = () => ({ allowed: false, reason: "private refusal text" });

describe("hitlQueueSource records who resolved the gate", () => {
  it("an owner ✅ through the mirror stores the owner, over Matrix, confirmed by the reaction", async () => {
    const file = migratedGateFile();
    const { hub, state, mirror } = await rig(undefined, new SqliteGateStore(openDatabase(file), { migrate: false }));
    const gate = new SqliteGateStore(openDatabase(file), { migrate: false }).create({ prompt: "merge?" });
    await mirror.reconcile();
    const ack = reaction(state.bySourceId(gate.id)!.eventId, "✅");

    await mirror.applySyncBatch(hub.deliver(ack));

    const reread = new SqliteGateStore(openDatabase(file), { migrate: false }).get(gate.id);
    expect(reread).toMatchObject({ status: "resolved", payload: { approved: true } });
    expect(reread?.resolvedBy).toEqual({ class: "owner-remote", id: OWNER, channel: "matrix", confirmEvent: ack.event_id });
  });

  it("a resolver the store refuses leaves the item open, marked refused, and the gate pending", async () => {
    const { store, hub, state, mirror } = await rig(undefined, new MemoryGateStore({ authorize: refuseAll }));
    const gate = store.create({ prompt: "merge?" });
    await mirror.reconcile();

    await mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "✅")));

    expect(store.get(gate.id)).toMatchObject({ status: "pending", resolvedBy: undefined });
    expect(state.bySourceId(gate.id)?.status).toBe("open");
    const bodies = JSON.stringify(hub.edits().map((edit) => edit.content["m.new_content"]));
    expect(bodies).toContain("refused: resolver owner-remote refused");
    expect(bodies).not.toContain("private refusal text");
  });

  it("a ✅ from anyone but the owner resolves nothing", async () => {
    const { store, hub, state, mirror } = await rig();
    const gate = store.create({ prompt: "merge?" });
    await mirror.reconcile();

    await mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "✅", STRANGER)));

    expect(store.get(gate.id)).toMatchObject({ status: "pending", resolvedBy: undefined });
    expect(state.bySourceId(gate.id)?.status).toBe("open");
    expect(hub.edits()).toEqual([]);
  });

  it("a gate store schema fault fails the batch loudly and leaves the item untouched", async () => {
    const inner = new MemoryGateStore();
    const outdated: GateStore = {
      create: (input) => inner.create(input),
      get: (id) => inner.get(id),
      listPending: () => inner.listPending(),
      cancel: (id, reason) => inner.cancel(id, reason),
      resolve: (id) => {
        throw new GateStoreSchemaOutdated(id, "hitl_gate", "gateResolverMigration");
      },
    };
    const { store, hub, state, mirror } = await rig(undefined, outdated);
    const gate = store.create({ prompt: "merge?" });
    await mirror.reconcile();

    const applying = mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "✅")));

    await expect(applying).rejects.toMatchObject({ name: "GateStoreSchemaOutdated" });
    expect(store.get(gate.id)?.status).toBe("pending");
    expect(state.bySourceId(gate.id)?.status).toBe("open");
    expect(state.syncToken()).toBeUndefined();
    expect(hub.edits()).toEqual([]);
  });

  it("an authorize that does not return a decision fails the batch loudly instead of refusing", async () => {
    const promised = (() => Promise.resolve({ allowed: true })) as unknown as GateAuthorize;
    const { store, hub, state, mirror } = await rig(undefined, new MemoryGateStore({ authorize: promised }));
    const gate = store.create({ prompt: "merge?" });
    await mirror.reconcile();

    const applying = mirror.applySyncBatch(hub.deliver(reaction(state.bySourceId(gate.id)!.eventId, "✅")));

    await expect(applying).rejects.toMatchObject({ name: "GateAuthorizeInvalid" });
    expect(store.get(gate.id)?.status).toBe("pending");
    expect(hub.edits()).toEqual([]);
  });

  it("resolverOf replaces the recorded resolver", async () => {
    const store = new MemoryGateStore();
    const gate = store.create({ prompt: "merge?" });
    const resolverOf = () => ({ class: "owner-terminal", id: "owner", channel: "bridge" }) as const;
    const source = hitlQueueSource(store, { machine: "m", session: "s", resolverOf });

    expect(await source.resolve(gate.id, { verdict: "allow", resolutionEventId: "$x", sender: OWNER })).toEqual({ ok: true });

    expect(store.get(gate.id)?.resolvedBy).toEqual({ class: "owner-terminal", id: "owner", channel: "bridge" });
  });
});
