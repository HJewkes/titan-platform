import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "matrix-js-sdk";
import { AppserviceClient } from "@titan-design/matrix-bus";

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

// Over @titan-design/matrix-bus, for the appservice's own sender_localpart (no masquerade query param).
export function appserviceClient(asToken, userId) {
  return new AppserviceClient({ baseUrl: env.HS_URL, asToken, userId, sender: userId });
}
