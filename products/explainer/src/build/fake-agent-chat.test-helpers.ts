import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Synthetic throughout: an invented session id and a one-request transcript; no real roster, profile or session.
export const FAKE_SESSION_ID = "c3c3c3c3-0000-4000-8000-000000000001";
export const FAKE_MODEL = "claude-sonnet-5-5";

/** One assistant request at the given token counts, in the shape a Claude Code transcript writes it. */
export function syntheticTranscript(sessionId: string, tokens: { input: number; output: number }): string {
  const line = {
    type: "assistant", sessionId, uuid: "u-1", timestamp: "2026-10-25T00:00:00.000Z",
    message: { id: "msg-1", role: "assistant", model: FAKE_MODEL, content: [{ type: "text", text: "Wrote the layer." }], usage: { input_tokens: tokens.input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: tokens.output } },
  };
  return `${JSON.stringify(line)}\n`;
}

// The fake's whole behaviour: `agent spawn` records argv and stdin, writes the canned module where the brief says and
// a transcript where Claude Code would, and lists the agent as exited; `agent ls` prints that roster; `retire` succeeds.
const SCRIPT = (state: string, configDir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const configDir = ${JSON.stringify(configDir)};
const args = process.argv.slice(2);
const at = (name) => path.join(state, name);
if (args[0] === "agent" && args[1] === "spawn") {
  const brief = fs.readFileSync(0, "utf8");
  fs.writeFileSync(at("argv.json"), JSON.stringify(args));
  fs.writeFileSync(at("brief.txt"), brief);
  const target = /Write the whole repaired module to (\\S+), and/.exec(brief)[1];
  if (fs.existsSync(at("repaired.tsx"))) fs.copyFileSync(at("repaired.tsx"), target);
  const sessionId = fs.readFileSync(at("session-id"), "utf8");
  const project = path.join(configDir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  fs.copyFileSync(at("transcript.jsonl"), path.join(project, sessionId + ".jsonl"));
  const row = { name: args[2], agentId: "agent-1", state: "exited", presence: "exited", status: "finished", profile: args[3], surface: "headless", cwd: process.cwd(), sessionId, generation: 1 };
  fs.writeFileSync(at("roster.json"), JSON.stringify([row]));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "ls") {
  process.stdout.write(fs.existsSync(at("roster.json")) ? fs.readFileSync(at("roster.json"), "utf8") : "[]");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "retire") process.exit(0);
process.stderr.write("fake agent-chat: unexpected " + args.join(" "));
process.exit(2);
`;

// A sibling test thread's fork can inherit an fd open for writing, and exec then fails ETXTBSY; cp writes it instead.
function installExecutable(file: string, contents: string): void {
  const staging = `${file}.staging`;
  writeFileSync(staging, contents);
  chmodSync(staging, 0o755);
  execFileSync("cp", ["-p", staging, file]);
  rmSync(staging);
}

export interface FakeAgentChat {
  bin: string;
  profilesDir: string;
  configDir: string;
  /** The argv `agent spawn` got, and the brief it read on stdin; undefined before a spawn. */
  spawn(): { argv: string[]; brief: string } | undefined;
}

/** A fake `agent-chat` under `root` whose repair agent writes `repaired` (nothing when absent) and spent `tokens`. */
export function fakeAgentChat(root: string, options: { repaired?: string; tokens?: { input: number; output: number } } = {}): FakeAgentChat {
  const state = path.join(root, "agent-chat-state");
  const configDir = path.join(root, "claude-config");
  const profilesDir = path.join(root, "profiles");
  for (const dir of [state, configDir, profilesDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(profilesDir, "beat-builder.json"), JSON.stringify({ surface: "headless" }));
  writeFileSync(path.join(state, "session-id"), FAKE_SESSION_ID);
  writeFileSync(path.join(state, "transcript.jsonl"), syntheticTranscript(FAKE_SESSION_ID, options.tokens ?? { input: 10_000, output: 2_000 }));
  if (options.repaired !== undefined) writeFileSync(path.join(state, "repaired.tsx"), options.repaired);
  const bin = path.join(root, "agent-chat");
  installExecutable(bin, SCRIPT(state, configDir));
  const spawn = () => {
    if (!existsSync(path.join(state, "argv.json"))) return undefined;
    return { argv: z.array(z.string()).parse(JSON.parse(readFileSync(path.join(state, "argv.json"), "utf8"))), brief: readFileSync(path.join(state, "brief.txt"), "utf8") };
  };
  return { bin, profilesDir, configDir, spawn };
}
