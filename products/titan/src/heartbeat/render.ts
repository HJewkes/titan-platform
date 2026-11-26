import { ARM_HOW } from "./harness-limits.js";
import type { IdleBeatOutcome } from "./run.js";

/** What a re-arm needs; `session` only when the caller named one, so a teleported seat picks up its new id. */
export interface IdleBeatArgs {
  /** The running titan bin, so the re-arm works whether or not `titan` is on PATH. */
  titanBin: string;
  idle: string;
  max?: string;
  lifetime?: string;
  prompt: string;
  stopCmd?: string;
  session?: string;
}

/** POSIX single quotes: safe to paste into any shell the seat runs. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function rearmCommand(args: IdleBeatArgs): string {
  const parts = ["node", args.titanBin, "heartbeat", "idle", "--idle", args.idle];
  if (args.max !== undefined) parts.push("--max", args.max);
  if (args.lifetime !== undefined) parts.push("--lifetime", args.lifetime);
  parts.push("--prompt", args.prompt);
  if (args.stopCmd !== undefined) parts.push("--stop-cmd", args.stopCmd);
  if (args.session !== undefined) parts.push("--session", args.session);
  return parts.map(shellQuote).join(" ");
}

const minutes = (ms: number): number => Math.floor(ms / 60_000);

/** The one wake line, or nothing when the session that armed it is gone. */
export function renderOutcome(outcome: IdleBeatOutcome, args: IdleBeatArgs): string {
  const rearm = `${rearmCommand(args)}  (${ARM_HOW})`;
  switch (outcome.kind) {
    case "beat": {
      const why = outcome.reason === "idle" ? `no turn for ${minutes(outcome.idleMs)} min` : `max interval ${args.max ?? ""} reached`;
      return `Idle heartbeat (${why}): ${args.prompt}\nWhen done, re-arm it: ${rearm}\n`;
    }
    case "stopped":
      return `Idle heartbeat stopped: the stop condition held. Re-arm it when there is work to watch: ${rearm}\n`;
    case "lapsed":
      return `Idle heartbeat lapsed after ${minutes(outcome.afterMs)} min with no beat due; it ends itself before the background task deadline. Re-arm it: ${rearm}\n`;
    case "session-gone":
      return "";
  }
}
