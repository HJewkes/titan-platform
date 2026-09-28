// broker-core: receives pushed appservice transactions and is the single writer for claims and endorsements.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { env, CORE_BOT, OWNER, asClient, log } from "./lib.mjs";

const PENDING_FILE = new URL("../data/core/pending.json", import.meta.url).pathname;
const core = asClient(env.CORE_AS_TOKEN, CORE_BOT);
const seenTxns = new Set();
const pendingEndorsements = new Map(existsSync(PENDING_FILE) ? Object.entries(JSON.parse(readFileSync(PENDING_FILE, "utf8"))) : []);
const APPROVE_KEYS = new Set(["👍", "✅", "approve"]);

// Write-then-rename so a kill mid-write never leaves a torn file.
function savePending() {
  writeFileSync(`${PENDING_FILE}.tmp`, JSON.stringify(Object.fromEntries(pendingEndorsements), null, 2));
  renameSync(`${PENDING_FILE}.tmp`, PENDING_FILE);
}

const claimKey = (worktree, glob) => createHash("sha256").update(`${worktree}\0${glob}`).digest("hex").slice(0, 32);
const globPrefix = (glob) => glob.split("*")[0];
const overlaps = (a, b) => a.worktree === b.worktree && (globPrefix(a.glob).startsWith(globPrefix(b.glob)) || globPrefix(b.glob).startsWith(globPrefix(a.glob)));

async function currentClaims(roomId) {
  const state = await core.roomState(roomId);
  return state.filter((e) => e.type === "io.titan.claim" && e.content?.holder);
}

async function handleClaimRequest(event) {
  const { worktree, glob } = event.content;
  const holder = (await currentClaims(event.room_id)).find((c) => overlaps(c.content, { worktree, glob }));
  const replyTo = { "m.relates_to": { "m.in_reply_to": { event_id: event.event_id } } };
  if (holder && holder.content.holder !== event.sender) {
    const body = `claim refused: ${glob} in ${worktree} overlaps ${holder.content.glob} held by ${holder.content.holder}`;
    await core.sendEvent(event.room_id, "io.titan.claim_refused", { body, holder: holder.content.holder, request: event.event_id, ...replyTo });
    log("core", body);
    return;
  }
  const key = claimKey(worktree, glob);
  await core.sendStateEvent(event.room_id, "io.titan.claim", { holder: event.sender, worktree, glob, request: event.event_id }, key);
  await core.sendEvent(event.room_id, "io.titan.claim_granted", { body: `claim granted to ${event.sender}: ${glob}`, state_key: key, ...replyTo });
  log("core", `claim granted ${event.sender} ${worktree}:${glob} state_key=${key}`);
}

async function handleEndorseRequest(event) {
  const { to, body } = event.content;
  const notice = await core.sendMessage(event.room_id, {
    msgtype: "m.notice",
    body: `Endorsement request from ${event.sender} to ${to}:\n\n${body}\n\nOwner: react 👍 or reply "approve".`,
  });
  pendingEndorsements.set(notice.event_id, { from: event.sender, to, body, request: event.event_id });
  savePending();
  log("core", `endorse request ${event.event_id} parked as notice ${notice.event_id}`);
}

function approvalTarget(event) {
  const rel = event.content?.["m.relates_to"];
  if (event.type === "m.reaction" && rel?.rel_type === "m.annotation" && APPROVE_KEYS.has(rel.key)) return rel.event_id;
  if (event.type === "m.room.message" && APPROVE_KEYS.has(event.content.body?.split("\n").pop().trim())) return rel?.["m.in_reply_to"]?.event_id;
  return undefined;
}

async function handleApproval(event, noticeId) {
  const pending = pendingEndorsements.get(noticeId);
  if (!pending) return;
  const endorsed = await core.sendEvent(event.room_id, "io.titan.endorsed", {
    body: pending.body, from: pending.from, to: pending.to, request: pending.request, approved_by: event.event_id,
  });
  pendingEndorsements.delete(noticeId);
  savePending();
  log("core", `endorsed ${endorsed.event_id} for ${pending.to} (approved by ${event.sender} via ${event.type})`);
}

async function handleEvent(event) {
  if (event.sender === CORE_BOT) return;
  if (event.type === "io.titan.claim_request") return handleClaimRequest(event);
  if (event.type === "io.titan.endorse_request") return handleEndorseRequest(event);
  const noticeId = approvalTarget(event);
  if (noticeId && event.sender === OWNER) return handleApproval(event, noticeId);
}

async function handleTransaction(txnId, payload) {
  if (seenTxns.has(txnId)) return;
  seenTxns.add(txnId);
  for (const event of payload.events ?? []) {
    try {
      await handleEvent(event);
    } catch (err) {
      log("core", `error on ${event.type} ${event.event_id}: ${err.errcode ?? ""} ${err.message}`);
    }
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

const server = createServer(async (req, res) => {
  const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? new URL(req.url, "http://x").searchParams.get("access_token");
  if (auth !== env.CORE_HS_TOKEN) {
    res.writeHead(403, { "content-type": "application/json" }).end('{"errcode":"M_FORBIDDEN"}');
    return;
  }
  const match = req.url.match(/\/transactions\/([^/?]+)/);
  if (req.method === "PUT" && match) await handleTransaction(match[1], await readJson(req));
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

server.listen(Number(env.CORE_PORT), process.env.CORE_BIND ?? "127.0.0.1", () => log("core", `listening for transactions on :${env.CORE_PORT}; ${pendingEndorsements.size} pending endorsements loaded`));
