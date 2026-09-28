// Step 3: owner account, the ac-edge1 mirror user, and #queue created by the owner over @titan-design/matrix-bus.
import { loginPassword, bootstrapQueueRoom } from "@titan-design/matrix-bus";
import {
  env, mxid, SERVER, appserviceClient, registerWithSharedSecret, saveState, loadState, log,
} from "./lib.mjs";

const MIRROR = "ac-edge1";

async function createAccounts() {
  const owner = await registerWithSharedSecret("owner", env.OWNER_PASSWORD);
  log("bootstrap", "owner via /_synapse/admin/v1/register:", owner.status, JSON.stringify(owner.body?.user_id ?? owner.body));
  const mirror = appserviceClient(env.EDGE1_AS_TOKEN, mxid(MIRROR));
  await mirror.register(MIRROR);
  log("bootstrap", `${MIRROR} via edge m.login.application_service`);
  return mirror;
}

async function main() {
  const mirror = await createAccounts();
  const owner = await loginPassword(env.HS_URL, "owner", env.OWNER_PASSWORD);
  const roomId = await bootstrapQueueRoom(owner, {
    alias: `#queue:${SERVER}`,
    mirrorUserIds: [mxid(MIRROR)],
    name: "queue",
  });
  await mirror.joinRoom(roomId);
  log("bootstrap", `${MIRROR} joined via masquerade`);
  saveState({ ...loadState(), queueRoomId: roomId });

  const state = await owner.state(roomId);
  const pick = (type) => state.find((e) => e.type === type)?.content;
  const members = state.filter((e) => e.type === "m.room.member").map((e) => `${e.state_key}=${e.content.membership}`);
  log("bootstrap", "room", roomId, "version", pick("m.room.create").room_version, "creator", state.find((e) => e.type === "m.room.create").sender);
  log("bootstrap", "members", members.join(" "));
  log("bootstrap", "power_levels", JSON.stringify(pick("m.room.power_levels")));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
