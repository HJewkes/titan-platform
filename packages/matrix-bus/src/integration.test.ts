import { beforeAll, describe, expect, it } from "vitest";
import { AppserviceClient, loginPassword } from "./client.js";
import { foldResolution } from "./fold.js";
import { MatrixError } from "./http.js";
import { encodeItem } from "./item.js";
import { bootstrapQueueRoom, queuePowerLevels } from "./room.js";
import type { MatrixEvent } from "./types.js";

// Runs against a live homeserver, e.g. the tp301 compose or deploy/hub on 127.0.0.1:8008.
const env = {
  baseUrl: process.env.MATRIX_BASE_URL ?? "",
  serverName: process.env.MATRIX_SERVER_NAME ?? "",
  ownerUser: process.env.MATRIX_OWNER_USER ?? "owner",
  ownerPassword: process.env.MATRIX_OWNER_PASSWORD ?? "",
  edgeAsToken: process.env.MATRIX_EDGE_AS_TOKEN ?? "",
  machine: process.env.MATRIX_EDGE_MACHINE ?? "edge1",
};

const log = (line: string) => console.log(`[matrix-bus it] ${line}`);

async function statusOf(send: Promise<unknown>): Promise<string> {
  try {
    await send;
    return "200";
  } catch (err) {
    if (err instanceof MatrixError) return `${err.status} ${err.errcode}`;
    throw err;
  }
}

const reactTo = (eventId: string) => ({ "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: "✅" } });

async function setUp() {
  const owner = await loginPassword(env.baseUrl, env.ownerUser, env.ownerPassword);
  const mirrorId = `@ac-${env.machine}:${env.serverName}`;
  const mirror = new AppserviceClient({ baseUrl: env.baseUrl, asToken: env.edgeAsToken, sender: mirrorId });
  const alias = `#queue-it-${Date.now()}:${env.serverName}`;
  const roomId = await bootstrapQueueRoom(owner, { alias, mirrorUserIds: [mirrorId] });
  await mirror.joinRoom(roomId);
  log(`bootstrapQueueRoom ${alias} -> ${roomId}; ${mirrorId} joined`);
  return { owner, mirror, alias, roomId };
}

describe.skipIf(!process.env.MATRIX_BASE_URL)("matrix-bus against a live homeserver", () => {
  let hub: Awaited<ReturnType<typeof setUp>>;
  beforeAll(async () => {
    hub = await setUp();
  });

  it("bootstraps #queue at v12, owner-created, with the section 4.1 levels", async () => {
    const state = await hub.owner.state(hub.roomId);
    const create = state.find((e) => e.type === "m.room.create")!;
    const levels = state.find((e) => e.type === "m.room.power_levels")!.content;
    log(`room_version ${String(create.content.room_version)} creator ${create.sender}`);
    log(`power_levels ${JSON.stringify(levels)}`);

    expect(create.content.room_version).toBe("12");
    expect(create.sender).toBe(hub.owner.userId);
    expect(levels).toMatchObject(queuePowerLevels());
  });

  it("refuses a reaction from the edge token and accepts the owner's, which folds to allow", async () => {
    const { owner, mirror, roomId } = hub;
    const item = encodeItem({ kind: "approval_request", machine: env.machine, session: "it", msg_id: "it1", at: Date.now(), tool_name: "Bash", input_preview: "ls", truncated: false, redacted: false });
    const { event_id: itemId } = await mirror.send(roomId, "m.room.message", item);
    log(`mirror posts item -> 200 ${itemId}`);

    const agentReaction = await statusOf(mirror.send(roomId, "m.reaction", reactTo(itemId)));
    const ownerReaction = await statusOf(owner.send(roomId, "m.reaction", reactTo(itemId)));
    log(`edge-token reaction -> ${agentReaction}`);
    log(`owner reaction -> ${ownerReaction}`);
    const { chunk } = await owner.messages(roomId, { limit: 10 });
    const reaction = chunk.find((e: MatrixEvent) => e.type === "m.reaction")!;
    const verdict = foldResolution(reaction, { ownerUserId: owner.userId!, itemEventIds: new Map([[itemId, "approval_request"]]) });
    log(`fold of the owner's reaction -> ${JSON.stringify(verdict)}`);

    expect(agentReaction).toBe("403 M_FORBIDDEN");
    expect(ownerReaction).toBe("200");
    expect(verdict).toEqual({ itemEventId: itemId, verdict: "allow" });
  });

  it("returns the existing room when the alias already resolves", async () => {
    const again = await bootstrapQueueRoom(hub.owner, { alias: hub.alias, mirrorUserIds: [] });
    log(`second bootstrapQueueRoom ${hub.alias} -> ${again === hub.roomId ? "same room" : again}`);

    expect(again).toBe(hub.roomId);
  });
});
