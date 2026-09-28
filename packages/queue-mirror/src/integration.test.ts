import { AppserviceClient, ITEM_KEY, bootstrapQueueRoom, encodeItem, loginPassword, type MatrixEvent } from "@titan-design/matrix-bus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMirrorState } from "./memory-state.js";
import { MemoryQueueSource } from "./memory-source.js";
import { runMirror } from "./run.js";
import type { QueueItem } from "./types.js";

// Runs against a live homeserver, e.g. the tp301 compose or deploy/hub on 127.0.0.1:8008.
const env = {
  baseUrl: process.env.MATRIX_BASE_URL ?? "",
  serverName: process.env.MATRIX_SERVER_NAME ?? "",
  ownerUser: process.env.MATRIX_OWNER_USER ?? "owner",
  ownerPassword: process.env.MATRIX_OWNER_PASSWORD ?? "",
  edgeAsToken: process.env.MATRIX_EDGE_AS_TOKEN ?? "",
  machine: process.env.MATRIX_EDGE_MACHINE ?? "edge1",
};

const log = (line: string) => console.log(`[queue-mirror it] ${line}`);

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  kind: "approval_request",
  machine: env.machine,
  session: "qm-it",
  at: Date.now(),
  toolName: "Bash",
  inputPreview: `echo ${id}`,
  ...extra,
});

const react = (eventId: string) => ({ "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: "✅" } });
const replyTo = (eventId: string, body: string) => ({ msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: eventId } } });

async function setUp() {
  const owner = await loginPassword(env.baseUrl, env.ownerUser, env.ownerPassword);
  const mirrorId = `@ac-${env.machine}:${env.serverName}`;
  const bus = new AppserviceClient({ baseUrl: env.baseUrl, asToken: env.edgeAsToken, sender: mirrorId });
  const alias = `#queue-qm-${Date.now()}:${env.serverName}`;
  const roomId = await bootstrapQueueRoom(owner, { alias, mirrorUserIds: [mirrorId] });
  await bus.joinRoom(roomId);
  log(`bootstrapQueueRoom ${alias} -> ${roomId}; ${mirrorId} joined`);
  return { owner, bus, roomId, mirrorId };
}

describe.skipIf(!process.env.MATRIX_BASE_URL)("queue-mirror against a live homeserver", () => {
  let hub: Awaited<ReturnType<typeof setUp>>;
  const source = new MemoryQueueSource();
  let state = new MemoryMirrorState();
  const logs: string[] = [];
  let controller = new AbortController();
  let running: Promise<void>;

  const start = () => {
    controller = new AbortController();
    const logger = { info: (msg: string) => logs.push(msg), warn: (msg: string) => logs.push(msg) };
    const options = { ownerUserId: hub.owner.userId!, roomId: hub.roomId, signal: controller.signal, logger, syncTimeoutMs: 1_000, sweepIntervalMs: 500 };
    running = runMirror(source, hub.bus, state, options);
  };
  const stop = async () => {
    controller.abort();
    await running;
  };
  const recent = async (): Promise<MatrixEvent[]> => (await hub.owner.messages(hub.roomId, { limit: 100 })).chunk;
  const posted = (id: string) => until(`${id} posted`, () => state.bySourceId(id));
  const editOf = async (eventId: string) =>
    (await recent()).find((event) => (event.content["m.relates_to"] as { rel_type?: string; event_id?: string } | undefined)?.event_id === eventId && "m.new_content" in event.content);

  beforeAll(async () => {
    hub = await setUp();
    start();
  });
  afterAll(stop);

  it("R1: one txnId sent from two client instances yields one event", async () => {
    const content = encodeItem({ kind: "notice", machine: env.machine, session: "qm-it", msg_id: "r1", at: Date.now(), text: "r1", truncated: false, redacted: false });
    const second = new AppserviceClient({ baseUrl: env.baseUrl, asToken: env.edgeAsToken, sender: hub.mirrorId });
    const txnId = `qm-r1-${Date.now()}`;

    const a = await hub.bus.send(hub.roomId, "m.room.message", content, txnId);
    const b = await second.send(hub.roomId, "m.room.message", content, txnId);
    log(`R1 same txnId, two AppserviceClient instances -> ${a.event_id} / ${b.event_id} (${a.event_id === b.event_id ? "deduped" : "NOT deduped"})`);

    expect(b.event_id).toBe(a.event_id);
  });

  it("posts an item, resolves it on the owner's ✅, and edits it with m.replace from the AS sender (R4)", async () => {
    source.add(item("it-allow"));
    const { eventId } = await posted("it-allow");
    await hub.owner.send(hub.roomId, "m.reaction", react(eventId));

    const resolution = await until("resolution", () => source.resolutions.find((r) => r.id === "it-allow"));
    const edit = await until("edit", () => editOf(eventId));
    log(`owner ✅ on ${eventId} -> source.resolve ${resolution.verdict}`);
    log(`R4 m.replace from ${edit.sender} -> ${edit.event_id} body ${JSON.stringify((edit.content["m.new_content"] as { body: string }).body)}`);

    expect(resolution.verdict).toBe("allow");
    expect(edit.sender).toBe(hub.mirrorId);
  });

  it("edits an item closed locally", async () => {
    source.add(item("it-close"));
    const { eventId } = await posted("it-close");
    source.close("it-close", "cancelled");

    const edit = await until("edit", () => editOf(eventId));
    log(`local close of ${eventId} -> m.replace ${edit.event_id}`);

    expect((edit.content["m.new_content"] as { body: string }).body).toContain("cancelled");
  });

  it("refuses the owner's ✅ on a redacted item", async () => {
    source.add(item("it-redacted", { inputPreview: "curl -H 'Authorization: Bearer sk-live-abc123'" }));
    const { eventId, approvable } = await posted("it-redacted");
    await hub.owner.send(hub.roomId, "m.reaction", react(eventId));

    await until("refusal", () => logs.includes("refused: redacted"));
    log(`owner ✅ on redacted ${eventId} (approvable ${approvable}) -> refused: redacted`);

    expect(source.resolutions.some((r) => r.id === "it-redacted")).toBe(false);
  });

  it("R6: answers a question from a reply with and without a legacy fallback", async () => {
    source.add(item("it-q1", { kind: "question", text: "which week?", inputPreview: undefined }));
    source.add(item("it-q2", { kind: "question", text: "which player?", inputPreview: undefined }));
    const q1 = await posted("it-q1");
    const q2 = await posted("it-q2");
    await hub.owner.send(hub.roomId, "m.room.message", replyTo(q1.eventId, "week 3"));
    await hub.owner.send(hub.roomId, "m.room.message", replyTo(q2.eventId, `> <${hub.mirrorId}> which player?\n\nBijan`));

    const answers = await until("answers", () => {
      const found = ["it-q1", "it-q2"].map((id) => source.resolutions.find((r) => r.id === id)?.text);
      return found.every(Boolean) ? found : undefined;
    });
    log(`R6 reply without fallback -> ${JSON.stringify(answers[0])}; with fallback -> ${JSON.stringify(answers[1])}`);

    expect(answers).toEqual(["week 3", "Bijan"]);
  });

  it("a restarted mirror posts no duplicate", async () => {
    source.add(item("it-open"));
    await posted("it-open");
    await stop();
    state = MemoryMirrorState.restore(state.snapshot());
    start();
    source.add(item("it-after"));
    await posted("it-after");

    const ids = (await recent()).flatMap((event) => {
      const record = event.content[ITEM_KEY] as { msg_id?: string } | undefined;
      return record?.msg_id && !("m.relates_to" in event.content) ? [record.msg_id] : [];
    });
    log(`after restart: ${ids.length} items, ${new Set(ids).size} distinct msg_ids`);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "it-open")).toHaveLength(1);
  });
});
