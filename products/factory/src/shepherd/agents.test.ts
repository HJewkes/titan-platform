import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatAgents } from "./agents.js";
import { createRosterReader } from "./roster.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-agents-"));
  // agent-dispatch refuses a spawn unless the profile is installed headless.
  mkdirSync(join(dir, "profiles"));
  writeFileSync(join(dir, "profiles", "impl.json"), JSON.stringify({ surface: "headless" }));
  vi.stubEnv("AGENT_CHAT_HOME", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated and drains the spawn brief from stdin. */
function fakeAgentChat(): string {
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, `#!/bin/sh\n: >"${dir}/argv"\nfor a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\ncat >/dev/null\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const recordedArgv = (): string[] => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);
const roster = createRosterReader(async () => []);

describe("the launcher Shepherd's agents are recorded under", () => {
  it("is shepherd on a spawn", async () => {
    await agentChatAgents(fakeAgentChat(), { timeoutMs: 10_000, roster }).spawn({ name: "agent-x", profile: "impl", brief: "b", cwd: dir });

    expect(recordedArgv()).toEqual(["agent", "spawn", "agent-x", "impl", "--launched-by", "shepherd", "--brief-stdin"]);
  });

  it("is shepherd on a resume", async () => {
    await agentChatAgents(fakeAgentChat(), { timeoutMs: 10_000, roster }).resume("agent-x", "wake");

    expect(recordedArgv()).toEqual(["agent", "resume", "agent-x", "--message", "wake", "--launched-by", "shepherd"]);
  });
});
