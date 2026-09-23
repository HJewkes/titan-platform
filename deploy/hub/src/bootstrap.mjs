// Step 3: owner account, two edge-masqueraded agents, and #coord created by the owner with typed power levels.
import {
  env, mxid, SERVER, CORE_BOT, EDGE1_A, EDGE1_B, asClient, rawRequest, registerAppserviceUser,
  registerWithSharedSecret, passwordClient, saveState, loadState, log,
} from "./lib.mjs";

const AGENTS = [EDGE1_A, EDGE1_B];

// Room v12: the owner creates the room, so it holds unbounded creator power and can demote the core; agents 0.
const POWER_LEVELS = {
  users: { [CORE_BOT]: 100 },
  users_default: 0,
  events_default: 0,
  state_default: 100,
  invite: 0,
  kick: 100,
  ban: 100,
  redact: 100,
  events: {
    "io.titan.endorsed": 100,
    "io.titan.claim": 100,
    "io.titan.resolution": 100,
    "m.room.power_levels": 100,
  },
};

async function createAccounts() {
  const owner = await registerWithSharedSecret("owner", env.OWNER_PASSWORD);
  log("bootstrap", "owner via /_synapse/admin/v1/register:", owner.status, JSON.stringify(owner.body?.user_id ?? owner.body));
  for (const agent of AGENTS) {
    const res = await registerAppserviceUser(env.EDGE1_AS_TOKEN, agent);
    log("bootstrap", `${agent} via edge m.login.application_service:`, res.status, JSON.stringify(res.body));
  }
}

// The core owns the #coord alias namespace, so it publishes the alias after joining the owner's room.
async function createCoordRoom(owner, core) {
  const alias = `#coord:${SERVER}`;
  const existing = await rawRequest("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`);
  if (existing.status === 200) return existing.body.room_id;
  const { room_id: roomId } = await owner.createRoom({
    name: "coord",
    preset: "private_chat",
    invite: [CORE_BOT, ...AGENTS.map(mxid)],
    power_level_content_override: POWER_LEVELS,
  });
  await core.joinRoom(roomId);
  await core.createAlias(alias, roomId);
  return roomId;
}

async function joinAgents(roomId) {
  for (const agent of AGENTS) {
    const client = asClient(env.EDGE1_AS_TOKEN, mxid(agent));
    await client.joinRoom(roomId);
    log("bootstrap", `${agent} joined via masquerade`);
  }
}

async function main() {
  await createAccounts();
  const core = asClient(env.CORE_AS_TOKEN, CORE_BOT);
  const owner = await passwordClient("owner", env.OWNER_PASSWORD);
  const roomId = await createCoordRoom(owner, core);
  await joinAgents(roomId);
  saveState({ ...loadState(), coordRoomId: roomId });

  const state = await rawRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, { token: env.CORE_AS_TOKEN });
  const pick = (type) => state.body.find((e) => e.type === type)?.content;
  const members = state.body.filter((e) => e.type === "m.room.member").map((e) => `${e.state_key}=${e.content.membership}`);
  log("bootstrap", "room", roomId, "version", pick("m.room.create").room_version, "creator", state.body.find((e) => e.type === "m.room.create").sender);
  log("bootstrap", "members", members.join(" "));
  log("bootstrap", "power_levels", JSON.stringify(pick("m.room.power_levels")));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
