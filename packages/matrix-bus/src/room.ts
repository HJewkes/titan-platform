import { MatrixError } from "./http.js";
import type { AppserviceClient } from "./client.js";

export interface PowerLevels {
  users: Record<string, number>;
  users_default: number;
  events_default: number;
  state_default: number;
  invite: number;
  kick: number;
  ban: number;
  redact: number;
  events: Record<string, number>;
}

/** #queue levels: members may post items, only the creator (the owner) may react or resolve. */
export function queuePowerLevels(): PowerLevels {
  return {
    users: {},
    users_default: 0,
    events_default: 0,
    state_default: 100,
    invite: 100,
    kick: 100,
    ban: 100,
    redact: 100,
    events: { "m.reaction": 100, "io.titan.resolution": 100, "m.room.power_levels": 100 },
  };
}

export interface BootstrapQueueOptions {
  /** Full alias, e.g. `#queue:chat.example.org`. */
  alias: string;
  mirrorUserIds: string[];
  name?: string;
}

const directoryPath = (alias: string) => `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`;

async function resolveAlias(client: AppserviceClient, alias: string): Promise<string | undefined> {
  try {
    return (await client.request<{ room_id: string }>("GET", directoryPath(alias))).room_id;
  } catch (err) {
    if (err instanceof MatrixError && err.status === 404) return undefined;
    throw err;
  }
}

/**
 * Creates the owner's #queue at the server's default room version (v12), so the owner is creator.
 * An alias that already resolves returns its room id unchanged.
 */
export async function bootstrapQueueRoom(owner: AppserviceClient, options: BootstrapQueueOptions): Promise<string> {
  const existing = await resolveAlias(owner, options.alias);
  if (existing) return existing;
  const { room_id: roomId } = await owner.request<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", {
    body: {
      preset: "private_chat",
      name: options.name ?? "queue",
      invite: options.mirrorUserIds,
      power_level_content_override: queuePowerLevels(),
    },
  });
  await owner.request("PUT", directoryPath(options.alias), { body: { room_id: roomId } });
  return roomId;
}
