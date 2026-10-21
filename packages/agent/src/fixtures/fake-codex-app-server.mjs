#!/usr/bin/env node
// A stand-in for `codex app-server` speaking stdio JSON-RPC, shaped on codex-cli 0.162.1 traffic.
// Flags:
//   --steers-to-complete <n>  a started turn stays active until it has taken n steers (default 0)
//   --exit-on <method>        exit without answering when this request arrives
//   --exit-code <n>           code for --exit-on (default 3)
//   --ask-approval            send a server request after turn/start, as Codex does for approvals
//   --log <path>              append every received line there
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const flags = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (!arg.startsWith("--")) return pairs;
    const next = all[i + 1];
    return [...pairs, [arg.slice(2), next === undefined || next.startsWith("--") ? "true" : next]];
  }, []),
);
const steersToComplete = Number(flags["steers-to-complete"] ?? 0);
const threadId = "01a15a00-0000-7000-8000-000000000001";
let turnCount = 0;
let activeTurn;
let steered = [];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const fail = (id, message) => send({ id, error: { code: -32600, message } });

function userMessage(text) {
  notify("item/completed", {
    threadId,
    turnId: activeTurn,
    item: { type: "userMessage", content: [{ type: "text", text }] },
  });
}

function completeTurn() {
  for (const text of steered) userMessage(text);
  const id = activeTurn;
  activeTurn = undefined;
  steered = [];
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", {
    threadId,
    turn: { id, status: "completed", items: [] },
  });
}

const handlers = {
  initialize: (id) =>
    reply(id, {
      userAgent: "fake/0.162.1",
      codexHome: "/fake/codex-home",
      platformFamily: "unix",
      platformOs: "linux",
    }),
  "thread/start": (id, params) => {
    reply(id, {
      thread: { id: threadId },
      model: "fake-model",
      cwd: params.cwd ?? "/fake/cwd",
    });
    notify("thread/started", { thread: { id: threadId } });
  },
  "thread/resume": (id, params) =>
    reply(id, {
      thread: { id: params.threadId },
      model: "fake-model",
      cwd: "/fake/cwd",
    }),
  "turn/start": (id) => {
    activeTurn = `turn-${++turnCount}`;
    reply(id, { turn: { id: activeTurn, status: "inProgress", items: [] } });
    notify("thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
    notify("turn/started", {
      threadId,
      turn: { id: activeTurn, status: "inProgress", items: [] },
    });
    if (flags["ask-approval"])
      send({
        id: "srv-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId },
      });
    if (steersToComplete === 0) completeTurn();
  },
  "turn/steer": (id, params) => {
    if (!activeTurn) return fail(id, "no active turn to steer");
    if (params.expectedTurnId !== activeTurn) {
      return fail(id, `expected active turn id \`${params.expectedTurnId}\` but found \`${activeTurn}\``);
    }
    steered.push(params.input.map((part) => part.text).join(""));
    reply(id, { turnId: activeTurn });
    if (steered.length >= steersToComplete) completeTurn();
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (flags.log) appendFileSync(flags.log, `${line}\n`);
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  if (message.method === flags["exit-on"]) process.exit(Number(flags["exit-code"] ?? 3));
  const handler = handlers[message.method];
  if (message.id === undefined) return;
  if (handler) handler(message.id, message.params ?? {});
  else
    send({
      id: message.id,
      error: { code: -32601, message: `unknown method ${message.method}` },
    });
});
