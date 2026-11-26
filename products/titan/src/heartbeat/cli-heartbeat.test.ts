import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { parseDuration } from "./cli-heartbeat.js";

const SESSION = "00000000-0000-4000-8000-0000000000aa";

/** A config dir holding one transcript whose last turn ended an hour before now. */
function configDirWithIdleSession(): string {
  const configDir = mkdtempSync(join(tmpdir(), "idle-beat-"));
  const project = join(configDir, "projects", "-synthetic-project");
  mkdirSync(project, { recursive: true });
  const ended = new Date(Date.now() - 60 * 60_000).toISOString();
  const records = [
    { type: "user", sessionId: SESSION, timestamp: ended, message: { role: "user", content: "start" } },
    { type: "assistant", sessionId: SESSION, timestamp: ended, message: { stop_reason: "end_turn", content: [{ type: "text" }] } },
  ];
  writeFileSync(join(project, `${SESSION}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return configDir;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t), env, titanBin: "/opt/titan/bin.js" };
  const code = await runCli(["heartbeat", "idle", ...args], io);
  return { code, out, err };
}

describe("titan heartbeat idle", () => {
  it("prints one wake line with the prompt and the re-arm command for an idle session", async () => {
    const env = { CLAUDE_CONFIG_DIR: configDirWithIdleSession(), CLAUDE_CODE_SESSION_ID: SESSION };

    const result = await run(["--idle", "20m", "--prompt", "Run the seat's tick"], env);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Idle heartbeat (no turn for 60 min): Run the seat's tick");
    expect(result.out).toContain(`re-arm it: node /opt/titan/bin.js heartbeat idle --idle 20m --prompt 'Run the seat'\\''s tick'  (with Bash run_in_background and timeout 7200000)`);
  });

  it("reports the stop instead of beating when the stop command exits 0", async () => {
    const env = { CLAUDE_CONFIG_DIR: configDirWithIdleSession(), CLAUDE_CODE_SESSION_ID: SESSION };

    const result = await run(["--idle", "20m", "--prompt", "tick", "--stop-cmd", "true"], env);

    expect(result.out).toMatch(/^Idle heartbeat stopped: the stop condition held\./);
  });

  it("refuses a max interval no longer than the idle threshold", async () => {
    const env = { CLAUDE_CONFIG_DIR: configDirWithIdleSession(), CLAUDE_CODE_SESSION_ID: SESSION };

    const result = await run(["--idle", "20m", "--max", "10m", "--prompt", "tick"], env);

    expect(result.code).toBe(64);
    expect(result.err).toContain("--max must be longer than --idle");
  });

  it("refuses a lifetime at or past the background task cap", async () => {
    const env = { CLAUDE_CONFIG_DIR: configDirWithIdleSession(), CLAUDE_CODE_SESSION_ID: SESSION };

    const result = await run(["--idle", "20m", "--lifetime", "2h", "--prompt", "tick"], env);

    expect(result.code).toBe(64);
    expect(result.err).toContain("under the 120 min background task cap");
  });

  it("refuses an idle threshold the lifetime would cut off before it fires", async () => {
    const env = { CLAUDE_CONFIG_DIR: configDirWithIdleSession(), CLAUDE_CODE_SESSION_ID: SESSION };

    const result = await run(["--idle", "2h", "--prompt", "tick"], env);

    expect(result.code).toBe(64);
    expect(result.err).toContain("shorter than --lifetime");
  });

  it("refuses to arm with no session id", async () => {
    const result = await run(["--idle", "20m", "--prompt", "tick"], { CLAUDE_CONFIG_DIR: configDirWithIdleSession() });

    expect(result.code).toBe(64);
    expect(result.err).toContain("CLAUDE_CODE_SESSION_ID is unset");
  });
});

describe("parseDuration", () => {
  it("reads seconds, minutes and hours, and a bare number as minutes", () => {
    expect([parseDuration("90s"), parseDuration("20m"), parseDuration("1h"), parseDuration("5")]).toEqual([90_000, 1_200_000, 3_600_000, 300_000]);
  });

  it("rejects zero and malformed durations", () => {
    expect([parseDuration("0m"), parseDuration("2d"), parseDuration("")]).toEqual([undefined, undefined, undefined]);
  });
});
