import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `agent-chat`: logs each call, serves `agent ls --json` from `roster.json`, and on a spawn or resume plays the
 * agent scripted in `behave/<name>.json`: an optional commit in its cwd, then transcript turns naming the commit.
 */
const FAKE = `
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = process.env.AGENT_CHAT_HOME, args = process.argv.slice(2);
const rosterPath = path.join(dir, "roster.json");
const roster = fs.existsSync(rosterPath) ? JSON.parse(fs.readFileSync(rosterPath, "utf8")) : [];
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, ...extra }) + "\\n");
if (args[1] === "ls") { log({}); process.stdout.write(JSON.stringify(roster)); process.exit(0); }
const name = args[2];
const behave = JSON.parse(fs.readFileSync(path.join(dir, "behave", name + ".json"), "utf8"));
let row = roster.find((r) => r.name === name);
if (args[1] === "spawn") {
  fs.readFileSync(0);
  row = { name, agentId: name, state: "exited", presence: "exited", status: "finished", profile: args[3], surface: "headless",
    cwd: process.cwd(), sessionId: "s-" + name, generation: 1, transcriptPath: path.join(dir, "t-" + name + ".jsonl") };
  roster.push(row);
}
const g = (...a) => cp.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...a], { cwd: row.cwd, encoding: "utf8" }).trim();
log({ head: g("rev-parse", "HEAD") });
if (behave.commit) { fs.writeFileSync(path.join(row.cwd, name + ".txt"), args[1]); g("add", "-A"); g("commit", "-qm", "work"); }
const head = g("rev-parse", "HEAD");
if (behave.pending) { row.presence = "live"; row.state = "live"; }
for (const turn of behave.turns || []) fs.appendFileSync(row.transcriptPath, turn.replace("{HEAD}", head) + "\\n");
fs.writeFileSync(rosterPath, JSON.stringify(roster));
`;

/**
 * Writes the fake into `dir`, its AGENT_CHAT_HOME, with an empty `behave/` and a headless profile per name in
 * `profiles`, and returns the bin path.
 */
export function installAgentChatFake(dir: string, profiles: readonly string[]): string {
  mkdirSync(join(dir, "behave"));
  mkdirSync(join(dir, "profiles"));
  for (const profile of profiles) writeFileSync(join(dir, "profiles", `${profile}.json`), JSON.stringify({ surface: "headless" }));
  // Written beside the bin and copied in: exec of a file another thread may still hold open for writing fails with ETXTBSY.
  writeFileSync(join(dir, "agent-chat.staging"), `#!${process.execPath}\n${FAKE}`);
  chmodSync(join(dir, "agent-chat.staging"), 0o755);
  cpSync(join(dir, "agent-chat.staging"), join(dir, "agent-chat"));
  return join(dir, "agent-chat");
}
