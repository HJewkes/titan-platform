import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configPath } from "./config.js";
import { configRef } from "./config-ref.js";
import { resetLimitsReadLog } from "./shepherd/limits-read.js";
import { spawnGate } from "./shepherd/spawn-gate.js";
import { gateLimits } from "./workflows.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function configHome(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "factory-gate-limits-"));
  dirs.push(home);
  mkdirSync(join(home, "titan-factory"));
  return { XDG_CONFIG_HOME: home, XDG_STATE_HOME: join(home, "state") };
}

const writeConfig = (env: NodeJS.ProcessEnv, config: object) => writeFileSync(configPath(env), JSON.stringify(config));

describe("gateLimits", () => {
  const hostHome = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const home = join(env.XDG_CONFIG_HOME ?? "", "agent-chat");
    mkdirSync(home);
    resetLimitsReadLog();
    return { ...env, AGENT_CHAT_HOME: home };
  };
  const writeHost = (env: NodeJS.ProcessEnv, shepherd: unknown) => writeFileSync(join(env.AGENT_CHAT_HOME ?? "", "config.json"), JSON.stringify({ limits: { version: 1, pools: {}, shepherd } }));

  it("lets the host's limits.shepherd beat the live factory rows the spawn gate reads", () => {
    const env = hostHome(configHome());
    writeConfig(env, { shepherd: { spawnGate: { load5: 30, buildLoad5: 12 }, agentChatBin: "/opt/agent-chat", review: { profile: "rv", maxConcurrent: 8 } } });
    writeHost(env, { review: { max_concurrent: 5 }, spawn_gate: { load5: 40 } });

    expect(gateLimits(configRef(configPath(env)), env)()).toEqual({ load5: 40, buildLoad5: 12, maxConcurrentReviews: 5 });
  });

  it("applies an edit to the host's limits.shepherd at the next read, without a restart", () => {
    const env = hostHome(configHome());
    writeConfig(env, { shepherd: { agentChatBin: "/opt/agent-chat", review: { profile: "rv", maxConcurrent: 8 } } });
    const limits = gateLimits(configRef(configPath(env)), env);
    expect(limits()).toEqual({ maxConcurrentReviews: 8 });

    writeHost(env, { review: { max_concurrent: 5 } });

    expect(limits()).toEqual({ maxConcurrentReviews: 5 });
  });

  it("keeps the factory values and logs once when the host's block is malformed", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = hostHome(configHome());
    writeConfig(env, { shepherd: { agentChatBin: "/opt/agent-chat", review: { profile: "rv", maxConcurrent: 8 } } });
    writeHost(env, { review: { max_concurrent: "many" } });
    const limits = gateLimits(configRef(configPath(env)), env);

    expect([limits(), limits()]).toEqual([{ maxConcurrentReviews: 8 }, { maxConcurrentReviews: 8 }]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("caps the spawn gate's review slots at the host's max_concurrent", () => {
    const env = hostHome(configHome());
    writeConfig(env, { shepherd: { agentChatBin: "/opt/agent-chat", review: { profile: "rv", maxConcurrent: 8 } } });
    writeHost(env, { review: { max_concurrent: 5 } });
    const gate = spawnGate({ limits: gateLimits(configRef(configPath(env)), env), read: () => ({ load5: 0, pressureLevel: 1, freeMemoryPct: 90 }), log: () => undefined });

    gate.noteReviewers({ running: [] });

    expect(gate.reviewSlots()?.cap).toBe(5);
  });
});
