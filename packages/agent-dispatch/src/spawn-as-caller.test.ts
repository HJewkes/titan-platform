import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerUnavailableError, DispatchError, agentChatEnv, buildSpawnArgs } from "./dispatch.js";
import { spawnAsCaller, type SpawnAsCallerRequest } from "./spawn-as-caller.js";
import { installExecutable } from "./test-support.js";

// Variables sh sets in its own environment, whatever the parent passed.
const SHELL_SET = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-caller-"));
  for (const key of ["AGENT_CHAT_NAME", "AGENT_CHAT_AGENT_ID", "CLAUDE_CONFIG_DIR", "AGENT_CHAT_HOME"]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Records argv (NUL-separated), env and stdin, then runs `script`. */
function fakeAgentChat(script = "exit 0\n"): string {
  const path = join(dir, "agent-chat");
  installExecutable(
    path,
    `#!/bin/sh\n` +
      `: >"${dir}/argv"\n` +
      `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n` +
      `/usr/bin/env -0 >"${dir}/env"\n` +
      `cat >"${dir}/stdin"\n` +
      script,
  );
  return path;
}

const recordedArgv = (): string[] => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

function recordedEnv(): Record<string, string> {
  const entries = readFileSync(join(dir, "env"), "utf8").split("\0").slice(0, -1);
  const pairs = entries.map((entry): [string, string] => [
    entry.slice(0, entry.indexOf("=")),
    entry.slice(entry.indexOf("=") + 1),
  ]);
  return Object.fromEntries(pairs.filter(([key]) => !SHELL_SET.has(key)));
}

const request = (bin: string, over: Partial<SpawnAsCallerRequest> = {}): SpawnAsCallerRequest => ({
  agentChatBinPath: bin,
  name: "synthetic-coord",
  profile: "synthetic-coordinator",
  brief: "Plan the synthetic work",
  cwd: dir,
  ...over,
});

describe("buildSpawnArgs placement flags", () => {
  const base = { peerName: "synthetic-coord", profile: "synthetic-coordinator" };

  it("leaves the argv exactly as before when no placement is given", () => {
    expect(buildSpawnArgs(base)).toEqual(["agent", "spawn", "synthetic-coord", "synthetic-coordinator", "--brief-stdin"]);
  });

  it.each([
    [{ host: "synthetic-host" }, ["--host", "synthetic-host"]],
    [{ account: "least-used" }, ["--account", "least-used"]],
    [{ surface: "headless" }, ["--surface", "headless"]],
    [{ remoteControl: true }, ["--remote-control"]],
    [{ remoteControl: false }, []],
  ])("sends %j as %j ahead of --brief-stdin", (placement, flags) => {
    expect(buildSpawnArgs({ ...base, ...placement })).toEqual([
      "agent",
      "spawn",
      "synthetic-coord",
      "synthetic-coordinator",
      ...flags,
      "--brief-stdin",
    ]);
  });
});

describe("spawnAsCaller", () => {
  it("passes every placement flag and keeps the brief on stdin, out of argv", async () => {
    const bin = fakeAgentChat();

    await spawnAsCaller(
      request(bin, { briefing: "synthetic-slug", host: "h1", account: "work", surface: "tmux", remoteControl: true }),
      10_000,
    );

    expect(recordedArgv()).toEqual([
      "agent", "spawn", "synthetic-coord", "synthetic-coordinator",
      "--briefing", "synthetic-slug",
      "--host", "h1", "--account", "work", "--surface", "tmux", "--remote-control",
      "--brief-stdin",
    ]);
    expect(recordedArgv().join(" ")).not.toContain("Plan the synthetic work");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("Plan the synthetic work");
  });

  it("forwards the caller's agent identity and account, and nothing else from its env", async () => {
    vi.stubEnv("AGENT_CHAT_NAME", "synthetic-parent");
    vi.stubEnv("AGENT_CHAT_AGENT_ID", "agent-0001");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic/config");
    vi.stubEnv("AGENT_CHAT_HOME", "/synthetic/chat-home");
    vi.stubEnv("SECRET_X", "do-not-leak");
    const bin = fakeAgentChat();

    await spawnAsCaller(request(bin), 10_000);

    expect(recordedEnv()).toEqual({
      ...agentChatEnv(),
      AGENT_CHAT_NAME: "synthetic-parent",
      AGENT_CHAT_AGENT_ID: "agent-0001",
      CLAUDE_CONFIG_DIR: "/synthetic/config",
    });
    expect(recordedEnv()).toHaveProperty("AGENT_CHAT_HOME", "/synthetic/chat-home");
  });

  it("runs as a human root, with no identity, when the caller's env has none", async () => {
    vi.stubEnv("AGENT_CHAT_NAME", "");
    const bin = fakeAgentChat();

    await spawnAsCaller(request(bin), 10_000);

    expect(recordedEnv()).toEqual(agentChatEnv());
  });

  it("returns the CLI's stdout lines, the account choice among them", async () => {
    const bin = fakeAgentChat(`printf 'account: work (least-used)\\n\\nSpawned synthetic-coord.\\n'\n`);

    const result = await spawnAsCaller(request(bin), 10_000);

    expect(result).toEqual({
      name: "synthetic-coord",
      lines: ["account: work (least-used)", "Spawned synthetic-coord."],
    });
  });

  it("reports the broker's refusal on stdout verbatim", async () => {
    const bin = fakeAgentChat(`echo "account: none fit (work over ceiling 93%)"\necho "Not spawned."\nexit 1\n`);

    const error = await spawnAsCaller(request(bin), 10_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DispatchError);
    expect((error as Error).message).toBe(
      "agent-chat refused the spawn: account: none fit (work over ceiling 93%)\nNot spawned.",
    );
  });

  it("reports an agent-chat too old to know --account by its usage error", async () => {
    const bin = fakeAgentChat(`echo "error: unknown option '--account'" >&2\nexit 1\n`);

    const error = await spawnAsCaller(request(bin, { account: "least-used" }), 10_000).catch((e: unknown) => e);

    expect((error as Error).message).toBe("agent-chat refused the spawn: error: unknown option '--account'");
  });

  it("marks an unreachable broker as unavailable, so a retry is safe", async () => {
    const bin = fakeAgentChat(`echo "could not reach or start the agent-chat broker" >&2\nexit 1\n`);

    const error = await spawnAsCaller(request(bin), 10_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrokerUnavailableError);
  });

  it("refuses a name agent-chat's registry would reject without starting the CLI", async () => {
    const bin = fakeAgentChat();

    const error = await spawnAsCaller(request(bin, { name: "Bad Name" }), 10_000).catch((e: unknown) => e);

    expect((error as Error).message).toBe("invalid peer name: 'Bad Name'");
  });
});
