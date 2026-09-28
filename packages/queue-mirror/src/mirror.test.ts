import { ITEM_KEY, type MatrixEvent } from "@titan-design/matrix-bus";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHub } from "./fake-hub.js";
import { MemoryMirrorState } from "./memory-state.js";
import { MemoryQueueSource } from "./memory-source.js";
import { createMirror, type Mirror, type MirrorOptions } from "./mirror.js";
import { runMirror } from "./run.js";
import type { MirrorState, QueueItem, SourceEvent } from "./types.js";

const OWNER = "@owner:hub.test";
const ROOM = "!queue:hub.test";

let seq = 0;
const reaction = (target: string, key = "✅", sender = OWNER): MatrixEvent => ({
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
const approval = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  kind: "approval_request",
  machine: "edge1",
  session: "tp316",
  at: 1_000,
  toolName: "Bash",
  inputPreview: `echo ${id}`,
  ...extra,
});

interface Rig {
  source: MemoryQueueSource;
  hub: FakeHub;
  state: MemoryMirrorState;
  mirror: Mirror;
  logs: string[];
  clock: { now: number };
}

function rig(state = new MemoryMirrorState(), source = new MemoryQueueSource(), hub = new FakeHub()): Rig {
  const logs: string[] = [];
  const clock = { now: 1_000 };
  const logger = { info: (msg: string) => logs.push(msg), warn: (msg: string) => logs.push(msg) };
  const options: MirrorOptions = { ownerUserId: OWNER, roomId: ROOM, signal: new AbortController().signal, logger, now: () => clock.now, approvalTtlMs: 60_000 };
  return { source, hub, state, mirror: createMirror(source, hub, state, options), logs, clock };
}

const eventIdOf = (state: MirrorState, id: string) => state.bySourceId(id)!.eventId;
const msgIds = (hub: FakeHub) => hub.items().map((event) => (event.content[ITEM_KEY] as { msg_id: string }).msg_id);

async function drain(r: Rig, from: string | undefined, count: number, onEach?: (index: number) => void): Promise<void> {
  const controller = new AbortController();
  let index = 0;
  for await (const event of r.source.tail(from, controller.signal) as AsyncIterable<SourceEvent>) {
    await r.mirror.applySourceEvent(event);
    index += 1;
    onEach?.(index);
    if (index === count) break;
  }
}

describe("source side replay", () => {
  it("restarting from a saved cursor loses and duplicates nothing", async () => {
    const first = rig();
    for (const id of ["a", "b", "c", "d", "e"]) first.source.add(approval(id));
    let saved = first.state.snapshot();
    await drain(first, "0", 5, (index) => {
      if (index === 3) saved = first.state.snapshot();
    });

    const second = rig(MemoryMirrorState.restore(saved), first.source, first.hub);
    await drain(second, second.state.sourceCursor(), 2);

    expect(msgIds(first.hub)).toEqual(["a", "b", "c", "d", "e"]);
    expect(second.state.openItems()).toHaveLength(5);
  });

  it("a send that fails leaves the cursor, so the restart posts the item", async () => {
    const first = rig();
    first.source.add(approval("a"));
    first.source.add(approval("b"));
    await drain(first, "0", 1);
    first.hub.failNextSends(1);

    await expect(drain(first, first.state.sourceCursor(), 1)).rejects.toThrow("send failed");
    const second = rig(MemoryMirrorState.restore(first.state.snapshot()), first.source, first.hub);
    await drain(second, second.state.sourceCursor(), 1);

    expect(msgIds(first.hub)).toEqual(["a", "b"]);
  });
});

describe("folding owner resolutions", () => {
  let r: Rig;
  beforeEach(async () => {
    r = rig();
    r.source.add(approval("a"));
    await r.mirror.reconcile();
  });

  it("an owner ✅ resolves allow, edits the item and closes it; a second ✅ is ignored", async () => {
    const target = eventIdOf(r.state, "a");

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(target)));
    await r.mirror.applySyncBatch(r.hub.deliver(reaction(target)));

    expect(r.source.resolutions.map((res) => [res.id, res.verdict])).toEqual([["a", "allow"]]);
    expect(r.state.bySourceId("a")?.status).toBe("closed");
    expect(r.hub.edits().map((edit) => (edit.content["m.new_content"] as { body: string }).body)).toEqual([
      "APPR from tp316 (edge1)\nresolved: allow",
    ]);
  });

  it("labels a phone verdict 'resolved: allow' even when the source's own close event lands mid-resolve", async () => {
    const resolve = r.source.resolve.bind(r.source);
    vi.spyOn(r.source, "resolve").mockImplementation(async (id, verdict) => {
      const result = await resolve(id, verdict);
      await r.mirror.applySourceEvent({ type: "closed", id, outcome: "resolved", label: verdict.verdict, cursor: "2" });
      return result;
    });

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, "a"))));

    expect(JSON.stringify(r.hub.edits().map((edit) => edit.content["m.new_content"]))).toContain("resolved: allow");
    expect(r.hub.edits()).toHaveLength(1);
  });

  it("a resync landing mid-resolve leaves the phone verdict's label on the item", async () => {
    const resolve = r.source.resolve.bind(r.source);
    vi.spyOn(r.source, "resolve").mockImplementation(async (id, verdict) => {
      const result = await resolve(id, verdict);
      await r.mirror.applySourceEvent({ type: "resync", cursor: "9" });
      return result;
    });

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, "a"))));

    expect(r.hub.edits().map((edit) => (edit.content["m.new_content"] as { body: string }).body)).toEqual(["APPR from tp316 (edge1)\nresolved: allow"]);
  });

    it("persists since only after the batch succeeds, and the same reaction twice resolves once", async () => {
    const event = reaction(eventIdOf(r.state, "a"));
    const resolve = vi.spyOn(r.source, "resolve").mockRejectedValueOnce(new Error("source down"));

    await expect(r.mirror.applySyncBatch({ since: "s1", events: [event], limited: false })).rejects.toThrow("source down");
    expect(r.state.syncToken()).toBeUndefined();
    await r.mirror.applySyncBatch({ since: "s1", events: [event], limited: false });
    await r.mirror.applySyncBatch({ since: "s2", events: [event], limited: false });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(r.source.resolutions).toHaveLength(1);
    expect(r.state.syncToken()).toBe("s2");
  });

  it("ignores a non-owner ✅ and a reply to an unrelated event, and logs both", async () => {
    const resolve = vi.spyOn(r.source, "resolve");

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, "a"), "✅", "@ac-edge1-x:hub.test"), reply("$unrelated", "allow")));

    expect(resolve).not.toHaveBeenCalled();
    expect(r.logs.filter((line) => line === "ignored")).toHaveLength(2);
  });

  it("marks a rejected verdict applied and leaves the item open", async () => {
    vi.spyOn(r.source, "resolve").mockResolvedValue({ ok: false, reason: "rejected", detail: "schema" });
    const event = reaction(eventIdOf(r.state, "a"));

    await r.mirror.applySyncBatch(r.hub.deliver(event));
    await r.mirror.applySyncBatch(r.hub.deliver(event));

    expect(r.source.resolve).toHaveBeenCalledTimes(1);
    expect(r.state.hasApplied(event.event_id)).toBe(true);
    expect(r.state.bySourceId("a")?.status).toBe("open");
    expect(r.logs).toContain("rejected");
  });

  it("edits a rejected item with the source's detail, keeps it open, and a later verdict still resolves it", async () => {
    vi.spyOn(r.source, "resolve").mockResolvedValueOnce({ ok: false, reason: "rejected", detail: "session no longer connected" });
    const send = vi.spyOn(r.hub, "send");
    const target = eventIdOf(r.state, "a");

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(target)));
    expect(r.state.bySourceId("a")?.status).toBe("open");
    await r.mirror.applySyncBatch(r.hub.deliver(reaction(target)));

    const bodies = r.hub.edits().map((edit) => (edit.content["m.new_content"] as { body: string }).body);
    expect(bodies).toEqual(["APPR from tp316 (edge1)\nrefused: session no longer connected", "APPR from tp316 (edge1)\nresolved: allow"]);
    const [rejectTxn, closeTxn] = send.mock.calls.map((call) => call[3]);
    expect(rejectTxn).not.toBe(closeTxn);
    expect(r.source.resolutions.map((res) => res.verdict)).toEqual(["allow"]);
  });

  it("labels a rejection without detail 'refused: rejected'", async () => {
    vi.spyOn(r.source, "resolve").mockResolvedValue({ ok: false, reason: "rejected" });

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, "a"))));

    expect(JSON.stringify(r.hub.edits()[0]?.content)).toContain("refused: rejected");
  });

  it("edits 'already resolved' when the source closed the item first", async () => {
    vi.spyOn(r.source, "resolve").mockResolvedValue({ ok: false, reason: "closed" });

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, "a"))));

    expect(r.state.bySourceId("a")?.status).toBe("closed");
    expect(JSON.stringify(r.hub.edits()[0]?.content)).toContain("already resolved");
  });
});

describe("unapprovable items", () => {
  it.each([
    ["redacted", approval("s", { inputPreview: "curl -H 'Authorization: Bearer abc123'" })],
    ["truncated", approval("t", { inputPreview: "x".repeat(70_000) })],
  ])("refuses an owner ✅ on a %s item", async (reason, item) => {
    const r = rig();
    r.source.add(item);
    await r.mirror.reconcile();
    const resolve = vi.spyOn(r.source, "resolve");

    await r.mirror.applySyncBatch(r.hub.deliver(reaction(eventIdOf(r.state, item.id))));

    expect(resolve).not.toHaveBeenCalled();
    expect(r.logs).toContain(`refused: ${reason}`);
    expect(r.state.bySourceId(item.id)?.approvable).toBe(false);
  });
});

describe("closing from the source and the clock", () => {
  it("a source closed event edits with m.replace targeting the original event", async () => {
    const r = rig();
    r.source.add(approval("a"));
    await drain(r, "0", 1);
    r.source.close("a", "cancelled");

    await drain(r, r.state.sourceCursor(), 1);

    const edit = r.hub.edits()[0]!;
    expect(edit.content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: eventIdOf(r.state, "a") });
    expect(edit.content["m.new_content"]).toMatchObject({ [ITEM_KEY]: { msg_id: "a" } });
    expect(r.state.sourceCursor()).toBe("2");
  });

  it("the sweep expires an approval past its TTL; a later ✅ and source close do nothing", async () => {
    const r = rig();
    r.source.add(approval("a"));
    await r.mirror.reconcile();
    const target = eventIdOf(r.state, "a");
    r.clock.now = 1_000 + 60_000;

    await r.mirror.sweepExpired();
    await r.mirror.applySyncBatch(r.hub.deliver(reaction(target)));
    await r.mirror.applySourceEvent({ type: "closed", id: "a", outcome: "expired", cursor: "9" });

    expect(r.source.resolutions).toEqual([]);
    expect(r.hub.edits()).toHaveLength(1);
    expect(JSON.stringify(r.hub.edits()[0]?.content)).toContain("expired");
  });

  it("a resync event closes items gone from open(), posts new ones once, and commits its cursor", async () => {
    const r = rig();
    r.source.add(approval("done"));
    r.source.add(approval("kept"));
    await r.mirror.reconcile();
    r.source.close("done", "resolved");
    r.source.add(approval("outofband"));

    await r.mirror.applySourceEvent({ type: "resync", cursor: "500" });
    await r.mirror.applySourceEvent({ type: "resync", cursor: "501" });

    expect(msgIds(r.hub)).toEqual(["done", "kept", "outofband"]);
    expect(r.state.bySourceId("done")?.status).toBe("closed");
    expect(JSON.stringify(r.hub.edits().map((edit) => edit.content))).toContain("resolved at the terminal");
    expect(r.state.openItems().map((item) => item.sourceId)).toEqual(["kept", "outofband"]);
    expect(r.state.sourceCursor()).toBe("501");
  });

  it("reconcile after downtime edits a vanished item, posts a new one and leaves an old open one", async () => {
    const r = rig();
    r.source.add(approval("gone"));
    r.source.add(approval("kept"));
    await r.mirror.reconcile();
    r.source.close("gone", "resolved");
    r.source.add(approval("new"));
    const send = vi.spyOn(r.hub, "send");

    await r.mirror.reconcile();

    expect(send).toHaveBeenCalledTimes(2);
    expect(msgIds(r.hub)).toEqual(["gone", "kept", "new"]);
    expect(r.hub.edits()).toHaveLength(1);
    expect(r.state.openItems().map((item) => item.sourceId)).toEqual(["kept", "new"]);
  });
});

describe("runMirror", () => {
  it("backs off 1 s then 2 s on sync failures and resets after a good batch", async () => {
    const source = new MemoryQueueSource();
    const hub = new FakeHub();
    const controller = new AbortController();
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      if (ms !== 5_000) sleeps.push(ms);
      if (ms === 5_000) await new Promise((resolve) => setTimeout(resolve, 1));
    });
    hub.failNextSyncs(2);
    hub.deliver();
    const options = { ownerUserId: OWNER, roomId: ROOM, signal: controller.signal, sleep };
    const running = runMirror(source, hub, new MemoryMirrorState(), options);
    await vi.waitFor(() => expect(sleeps).toEqual([1_000, 2_000]));

    hub.failNextSyncs(1);
    hub.deliver();
    await vi.waitFor(() => expect(sleeps).toEqual([1_000, 2_000, 1_000]));
    controller.abort();
    await running;
  });

  it("posts an item opened between tail() and reconcile's open() exactly once", async () => {
    const source = new MemoryQueueSource();
    const hub = new FakeHub();
    const controller = new AbortController();
    const open = source.open.bind(source);
    let release!: () => void;
    const openCalled = new Promise<void>((called) => {
      vi.spyOn(source, "open").mockImplementation(async () => {
        const snapshot = await open();
        called();
        await new Promise<void>((resume) => (release = resume));
        return snapshot;
      });
    });
    const running = runMirror(source, hub, new MemoryMirrorState(), { ownerUserId: OWNER, roomId: ROOM, signal: controller.signal, sweepIntervalMs: 5 });

    await openCalled;
    source.add(approval("gap"));
    release();

    await vi.waitFor(() => expect(msgIds(hub)).toEqual(["gap"]));
    controller.abort();
    await running;
    expect(msgIds(hub)).toEqual(["gap"]);
  });

  it("posts an item added while running, and stops on abort", async () => {
    const source = new MemoryQueueSource();
    const hub = new FakeHub();
    const controller = new AbortController();
    const running = runMirror(source, hub, new MemoryMirrorState(), { ownerUserId: OWNER, roomId: ROOM, signal: controller.signal, sweepIntervalMs: 5 });
    await vi.waitFor(() => expect(hub.items()).toHaveLength(0));

    source.add(approval("live"));
    await vi.waitFor(() => expect(msgIds(hub)).toEqual(["live"]));
    controller.abort();
    await running;
  });
});
