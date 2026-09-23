import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient, RoomEvent, ClientEvent } from "matrix-js-sdk";

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, getChild: () => quiet };

const ROOT = new URL("..", import.meta.url).pathname;
const STATE = `${ROOT}data/state.json`;

const fileEnv = Object.fromEntries(
  readFileSync(`${ROOT}.env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
// The core container reaches Tuwunel by service name, so the compose environment overrides HS_URL.
export const env = { ...fileEnv, HS_URL: process.env.HS_URL ?? fileEnv.HS_URL };

export const SERVER = env.SERVER_NAME;
export const mxid = (localpart) => `@${localpart}:${SERVER}`;
export const CORE_BOT = mxid("core-bot");
export const OWNER = mxid("owner");
// edge1's appservice namespace is @ac-edge1-.*, so its token cannot act as another machine's agents.
export const EDGE1_A = "ac-edge1-a";
export const EDGE1_B = "ac-edge1-b";

export const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
export const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

export const log = (who, ...rest) => console.log(`${new Date().toISOString()} [${who}]`, ...rest);

// Masquerade: every request, including /sync, carries ?user_id= with the appservice token.
export function asClient(asToken, userId) {
  return createClient({
    baseUrl: env.HS_URL,
    accessToken: asToken,
    userId,
    queryParams: { user_id: userId },
    logger: quiet,
  });
}

export async function rawRequest(method, path, { token, body, query } = {}) {
  const url = new URL(path, env.HS_URL);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function registerAppserviceUser(asToken, localpart) {
  const res = await rawRequest("POST", "/_matrix/client/v3/register", {
    token: asToken,
    body: { type: "m.login.application_service", username: localpart, inhibit_login: true },
  });
  if (res.status !== 200 && res.body?.errcode !== "M_USER_IN_USE") throw new Error(JSON.stringify(res));
  return res;
}

// Synapse-style shared-secret registration: the admin path, so public registration stays closed.
export async function registerWithSharedSecret(username, password) {
  const path = "/_synapse/admin/v1/register";
  const { body: nonceBody } = await rawRequest("GET", path);
  const mac = createHmac("sha1", env.REG_SHARED_SECRET)
    .update(`${nonceBody.nonce}\0${username}\0${password}\0notadmin`)
    .digest("hex");
  const res = await rawRequest("POST", path, {
    body: { nonce: nonceBody.nonce, username, password, admin: false, mac },
  });
  if (res.status !== 200 && res.body?.errcode !== "M_USER_IN_USE") throw new Error(JSON.stringify(res));
  return res;
}

export async function passwordClient(localpart, password) {
  const login = await rawRequest("POST", "/_matrix/client/v3/login", {
    body: { type: "m.login.password", identifier: { type: "m.id.user", user: localpart }, password },
  });
  if (login.status !== 200) throw new Error(JSON.stringify(login));
  return createClient({ baseUrl: env.HS_URL, accessToken: login.body.access_token, userId: login.body.user_id, logger: quiet });
}

export async function startSynced(client) {
  const ready = new Promise((resolve) =>
    client.on(ClientEvent.Sync, (state) => state === "PREPARED" && resolve()),
  );
  await client.startClient({ initialSyncLimit: 0 });
  await ready;
  return client;
}

export function waitForEvent(client, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(RoomEvent.Timeline, onEvent);
      reject(new Error(`timeout waiting on ${client.getUserId()}`));
    }, timeoutMs);
    function onEvent(event, _room, toStart) {
      if (toStart || !predicate(event)) return;
      clearTimeout(timer);
      client.off(RoomEvent.Timeline, onEvent);
      resolve(event);
    }
    client.on(RoomEvent.Timeline, onEvent);
  });
}
