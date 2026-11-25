import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { findClaudeSessionSource, readClaudeTurnState } from "@titan-design/session-read";
import { renderOutcome, type IdleBeatArgs } from "./render.js";
import { waitForIdleBeat, type IdleBeatPorts } from "./run.js";

export interface HeartbeatIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  titanBin: string;
  setExitCode: (code: number) => void;
}

interface IdleOptions {
  idle: string;
  max?: string;
  prompt: string;
  stopCmd?: string;
  session?: string;
  poll: string;
}

const EXIT_USAGE = 64;
const STOP_CMD_TIMEOUT_MS = 60_000;
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** `90s`, `20m`, `1h`; a bare number is minutes. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)([smh]?)$/.exec(text.trim());
  if (match === null) return undefined;
  const ms = Number(match[1]) * (UNIT_MS[match[2] || "m"] ?? 0);
  return ms > 0 ? ms : undefined;
}

export function registerHeartbeat(program: Command, io: HeartbeatIo): void {
  program
    .command("heartbeat")
    .description("Wake a Claude Code session on its own idle time")
    .command("idle")
    .description("Wait until the session has gone --idle without a turn, print one wake line, and exit")
    .requiredOption("--idle <duration>", "idle time since the last turn that fires the beat (90s, 20m, 1h)")
    .requiredOption("--prompt <text>", "what the wake line asks the session to do")
    .option("--max <duration>", "fire anyway this long after arming, at the next moment the session is between turns")
    .option("--stop-cmd <command>", "shell command checked when a beat is due; exit 0 stops the beat instead")
    .option("--session <id>", "Claude Code session id (default: CLAUDE_CODE_SESSION_ID)")
    .option("--poll <duration>", "how often to read the transcript", "30s")
    .action(async (opts: IdleOptions) => runIdle(opts, io));
}

async function runIdle(opts: IdleOptions, io: HeartbeatIo): Promise<void> {
  const idleMs = parseDuration(opts.idle);
  const maxMs = opts.max === undefined ? undefined : parseDuration(opts.max);
  const pollMs = parseDuration(opts.poll);
  if (idleMs === undefined || pollMs === undefined || (opts.max !== undefined && (maxMs === undefined || maxMs <= idleMs))) {
    return usage(io, "--idle and --poll take a duration such as 90s, 20m or 1h, and --max must be longer than --idle");
  }
  const sessionId = opts.session ?? io.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId === undefined || sessionId === "") return usage(io, "no --session given and CLAUDE_CODE_SESSION_ID is unset");
  const transcript = locateTranscript(sessionId, io.env);
  if (typeof transcript !== "string") return usage(io, transcript.error);
  const args: IdleBeatArgs = { titanBin: io.titanBin, idle: opts.idle, max: opts.max, prompt: opts.prompt, stopCmd: opts.stopCmd, session: opts.session };
  const outcome = await waitForIdleBeat({ idleMs, maxMs }, pollMs, realPorts(transcript, opts.stopCmd, io.env));
  io.stdout(renderOutcome(outcome, args));
}

function usage(io: HeartbeatIo, message: string): void {
  io.stderr(`titan heartbeat idle: ${message}\n`);
  io.setExitCode(EXIT_USAGE);
}

function locateTranscript(sessionId: string, env: NodeJS.ProcessEnv): string | { error: string } {
  const lookup = findClaudeSessionSource({
    cwd: process.cwd(),
    ...(env.CLAUDE_CONFIG_DIR ? { configDir: env.CLAUDE_CONFIG_DIR } : {}),
    conversation: { harness: "claude-code", namespace: "default", nativeId: sessionId },
  });
  if (lookup.status === "found") return lookup.source.path;
  return { error: lookup.status === "not_written" ? `no transcript yet for session ${sessionId}` : lookup.reason };
}

function realPorts(transcript: string, stopCmd: string | undefined, env: NodeJS.ProcessEnv): IdleBeatPorts {
  const pid = Number(env.CLAUDE_PID);
  return {
    readTurn: () => readClaudeTurnState(transcript),
    now: Date.now,
    sleep: (ms) => sleep(ms),
    stopHolds: () => stopCmd !== undefined && spawnSync("sh", ["-c", stopCmd], { stdio: "ignore", timeout: STOP_CMD_TIMEOUT_MS }).status === 0,
    sessionAlive: () => !Number.isInteger(pid) || pid <= 0 || processExists(pid),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
