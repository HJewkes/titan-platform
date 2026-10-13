import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitHubPort } from "@titan-design/github";

/**
 * session-miner's writer for the gh-calls v1 log (TP-1172). The format is owned by agent-chat's
 * docs/gh-calls.md and shared by format, not code: one JSONL line per GitHub call, one file per UTC day.
 */

const KEEP_DAYS = 7;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface GhCallLine {
  v: 1;
  at: string;
  caller: "session-miner";
  api: "rest";
  method: "GET";
  route: string;
  /** The port hides the response, so a success is `ok`; a failure carries its HTTP status when the error has one. */
  status: number | "ok" | "error";
  ms: number;
  remaining: null;
  resource: null;
}

type AppendCall = (line: GhCallLine) => void;

const ghCallsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "gh-calls");

/** Appends to the line's day file, pruning older days on a day's first write; a GitHub read never fails on its log line. */
export function appendCallFile(dir: string = ghCallsDir()): AppendCall {
  return (line) => {
    try {
      const day = line.at.slice(0, 10);
      const file = path.join(dir, `${day}.jsonl`);
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        pruneDays(dir, day);
      }
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {
      return;
    }
  };
}

function pruneDays(dir: string, today: string): void {
  const cutoff = new Date(Date.parse(today) - (KEEP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const day = DAY_FILE.exec(name)?.[1];
    if (day !== undefined && day < cutoff) unlinkSync(path.join(dir, name));
  }
}

function failureStatus(error: unknown): number | "error" {
  if (typeof error !== "object" || error === null || !("status" in error)) return "error";
  return typeof error.status === "number" ? error.status : "error";
}

/** Wraps `port` so each `getPr` appends one line; every other method and every result passes through untouched. */
export function loggedGitHubPort<P extends Pick<GitHubPort, "getPr">>(port: P, append: AppendCall = appendCallFile(), now: () => number = Date.now): P {
  const getPr: GitHubPort["getPr"] = async (repo, number) => {
    const started = now();
    const log = (status: GhCallLine["status"]) => {
      const finished = now();
      append({ v: 1, at: new Date(finished).toISOString(), caller: "session-miner", api: "rest", method: "GET", route: "repos/{o}/{r}/pulls/{n}", status, ms: finished - started, remaining: null, resource: null });
    };
    try {
      const pull = await port.getPr(repo, number);
      log("ok");
      return pull;
    } catch (error) {
      log(failureStatus(error));
      throw error;
    }
  };
  return { ...port, getPr };
}
