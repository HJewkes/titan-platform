import { join } from "node:path";
import { redactCredentials } from "./redact.js";
import type { WatchIntent } from "./deploy-watch-window.js";
import type { CommandResult, ServicePorts } from "./service-control.js";

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_CHARS = 2_000;
const BUILD_LOG_TAIL_LINES = 200;
const BUILD_LOG_STREAM_CHARS = 64_000;

/** The open or last watch window's `{sha, windowEnd}`. */
export const deployWindowPath = (stateDir: string): string => join(stateDir, "deploy-window.json");

/** The record is for readers of the window, never a reason to fail the deploy it describes, so a failed write is a warning. */
export function writeWindowRecord(ports: Pick<ServicePorts, "writeFile">, stateDir: string, intent: WatchIntent): string | undefined {
  try {
    ports.writeFile(deployWindowPath(stateDir), `${JSON.stringify(intent)}\n`);
    return undefined;
  } catch (error) {
    return `warning: the watch window could not be recorded: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

/** Holds the newest failed install or build's output, longer than the `why` can carry. */
export const deployBuildLogPath = (stateDir: string): string => join(stateDir, "deploy-build.log");

/** Redacted before the cut, so a cut can never leave a token without the prefix that marks it. */
function lastLines(text: string, lines: number, chars: number): string {
  const kept = redactCredentials(text.trim()).split("\n").slice(-lines).join("\n");
  return kept.length <= chars ? kept : `…${kept.slice(-chars)}`;
}

function tail(name: string, text: string): string[] {
  const kept = lastLines(text, OUTPUT_TAIL_LINES, OUTPUT_TAIL_CHARS);
  return kept === "" ? [] : [`${name}:\n${kept}`];
}

export function buildLog(command: string, target: string, at: string, result: CommandResult): string {
  const stream = (text: string) => lastLines(text, BUILD_LOG_TAIL_LINES, BUILD_LOG_STREAM_CHARS);
  return [`command: ${command}`, `target: ${target}`, `at: ${at}`, `exit ${result.code}`, "stderr:", stream(result.stderr), "stdout:", stream(result.stdout), ""].join("\n");
}

/** Both streams, since pnpm prints a failing script's output on stdout and leaves stderr empty. */
export const detail = (result: CommandResult): string => [`exit ${result.code}`, ...tail("stderr", result.stderr), ...tail("stdout", result.stdout)].join("\n");

/** A transient failure may never recur, so its output is kept; a failed write must not stop the rollback that follows. */
export function writeBuildLog(ports: Pick<ServicePorts, "writeFile">, stateDir: string, text: string): string {
  const path = deployBuildLogPath(stateDir);
  try {
    ports.writeFile(path, text);
    return `full output: ${path}`;
  } catch (error) {
    return `full output not written: ${error instanceof Error ? error.message : String(error)}`;
  }
}
