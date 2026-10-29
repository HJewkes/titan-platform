import { decodeClaudeToolLines, type ClaudeToolLine } from "@titan-design/session-read";
import { z } from "zod";
import { classifyFollowUp } from "./follow-up-class.js";
import type { FrictionCluster } from "./friction-lines.js";
import { classifyError, type ErrorClass } from "./tool-error-class.js";

export const LOG_SIGNAL_KINDS = ["denial", "tool-error", "retry", "test-rerun", "wait", "follow-up"] as const;
export type LogSignalKind = (typeof LOG_SIGNAL_KINDS)[number];

/** One costly moment in a worker's own log; `hours` is the time it held the worker, not the session's length. */
export interface LogSignal {
  cluster: FrictionCluster;
  kind: LogSignalKind;
  at: string;
  hours: number;
  detail: string;
}

/** A gap longer than this is a wait, whether a tool ran that long or nothing happened. */
export const LONG_WAIT_MS = 5 * 60_000;
/** An error's cost is the time to the worker's next move, held to this so a long pause after it is not all blamed on it. */
const REACTION_CAP_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

const DENIAL_CLASSES: ReadonlySet<ErrorClass> = new Set(["classifier-denial", "permission-denied", "user-rejected", "sleep-block", "hook-block"]);
const ERROR_CLUSTER: Partial<Record<ErrorClass, FrictionCluster>> = {
  "classifier-denial": "denials",
  "permission-denied": "denials",
  "user-rejected": "denials",
  "sleep-block": "denials",
  "hook-block": "denials",
  "wrong-tool-name": "missing-context",
  "edit-not-read": "missing-context",
  "edit-no-match": "missing-context",
  "file-missing": "missing-context",
  "gh-graphql-ratelimit": "broker-infra",
  "gh-secondary-ratelimit": "broker-infra",
  "gh-other": "broker-infra",
  timeout: "broker-infra",
  "mcp-tool-error": "broker-infra",
  "agent-chat-refused": "broker-infra",
};

const CI_POLL = /\bgh (?:pr checks|run (?:watch|view|list))\b|\bgh pr view\b.*\bstatusCheckRollup\b/;
const TEST_RUN = /\b(?:vitest|jest|pytest|go test|cargo test|npm test|pnpm (?:[\w-]+ )*test)\b/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DENIAL_TEXT = /auto mode classifier\. Reason:|Permission to use .* (?:has been )?denied/;

const hoursOf = (ms: number) => Math.max(0, ms) / HOUR_MS;
const commandOf = (input: unknown): string => {
  const command = typeof input === "object" && input !== null ? Reflect.get(input, "command") : undefined;
  return typeof command === "string" ? command.trim() : "";
};
const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((part: unknown) => {
    const text = typeof part === "object" && part !== null ? Reflect.get(part, "text") : undefined;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

interface Call {
  name: string;
  command: string;
  at: number;
}

/** Tool lines inside the window, oldest first, each with its epoch time. */
function windowLines(lines: readonly string[], window: { since: string; until: string }): (ClaudeToolLine & { ms: number })[] {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  return [...decodeClaudeToolLines(lines)]
    .flatMap((line) => (line.timestamp === null ? [] : [{ ...line, ms: Date.parse(line.timestamp) }]))
    .filter((line) => line.ms >= since && line.ms < until)
    .sort((a, b) => a.ms - b.ms);
}

const PROMPT_LINE = /"type":\s*"user"/;
const timestamped = z.object({ timestamp: z.string() });

/** When each new prompt arrived: a user record with no tool result in it opens a turn. */
function promptTimes(lines: readonly string[]): number[] {
  return lines.flatMap((raw) => {
    if (!PROMPT_LINE.test(raw) || raw.includes('"tool_result"')) return [];
    try {
      const record = timestamped.safeParse(JSON.parse(raw));
      return record.success ? [Date.parse(record.data.timestamp)] : [];
    } catch {
      return [];
    }
  });
}

/** A gap that ends in a new prompt is time between turns, such as a parked worker resumed, not a wait inside one. */
const sameTurn = (prompts: readonly number[]) => (from: number, to: number) => !prompts.some((p) => p > from && p <= to);

/** Checks run here or polled for: local suites, builds and the loops that wait on a background run's exit line. */
const CHECK_RUN = /\b(?:basement-suite|vitest|vite|jest|pytest|tsc|npm run|pnpm (?:[\w-]+ )*(?:test|build|typecheck|lint|verify\S*|dag:check|docs:build))\b|\buntil grep\b.*\bexit=/;
const CONTAINER = /\bdocker\b|DOCKER_HOST/;

/** The wait a call caused takes the call's cluster: checks, local or on GitHub, are `ci-wait`; anything else is not yet a named cause. */
function waitCluster(call: Call | undefined): FrictionCluster {
  if (!call) return "other";
  if (CI_POLL.test(call.command) || CHECK_RUN.test(call.command)) return "ci-wait";
  return CONTAINER.test(call.command) ? "broker-infra" : "other";
}

/**
 * The window's friction in one worker transcript: denials and tool errors (Q5's classes), waits over
 * five minutes, and a Bash command run again with no edit since its last run (a test re-run is the
 * flaky-test signal; a repeated CI poll is a CI wait).
 */
export function transcriptSignals(lines: readonly string[], window: { since: string; until: string }): LogSignal[] {
  const tool = windowLines(lines, window);
  const inTurn = sameTurn(promptTimes(lines));
  const calls = new Map<string, Call>();
  const runs = new Map<string, { edits: number; cluster: FrictionCluster }>();
  const signals: LogSignal[] = [];
  let edits = 0;
  let last: Call | undefined;
  tool.forEach((line, i) => {
    const at = new Date(line.ms).toISOString();
    const previous = tool[i - 1];
    if (line.kind === "tool_call") {
      if (previous && inTurn(previous.ms, line.ms)) signals.push(...waitSignal(last, previous.ms, line.ms, `idle after ${label(last)}`));
      const call = { name: line.name, command: line.name === "Bash" ? commandOf(line.input) : "", at: line.ms };
      calls.set(line.callId, call);
      last = call;
      if (EDIT_TOOLS.has(line.name)) edits += 1;
      if (call.command) signals.push(...repeatSignal(runs, call, edits, at));
      return;
    }
    const call = calls.get(line.callId);
    if (call) signals.push(...waitSignal(call, call.at, line.ms, `${label(call)} ran`));
    const error = errorSignal(line, at, tool[i + 1]?.ms);
    if (!error) return;
    signals.push(error);
    if (call?.command) runs.set(call.command, { edits, cluster: error.cluster });
  });
  return signals;
}

const label = (call: Call | undefined) => clip(call?.command || call?.name || "start");

/** A wait when the gap passes five minutes, charged to the call that caused it. */
function waitSignal(call: Call | undefined, fromMs: number, toMs: number, detail: string): LogSignal[] {
  if (toMs - fromMs <= LONG_WAIT_MS) return [];
  return [{ cluster: waitCluster(call), kind: "wait", at: new Date(toMs).toISOString(), hours: hoursOf(toMs - fromMs), detail }];
}

function repeatSignal(runs: Map<string, { edits: number; cluster: FrictionCluster }>, call: Call, edits: number, at: string): LogSignal[] {
  const before = runs.get(call.command);
  runs.set(call.command, { edits, cluster: "other" });
  if (!before || before.edits !== edits) return [];
  if (TEST_RUN.test(call.command)) return [{ cluster: "flaky-test", kind: "test-rerun", at, hours: 0, detail: clip(call.command) }];
  return [{ cluster: CI_POLL.test(call.command) ? "ci-wait" : before.cluster, kind: "retry", at, hours: 0, detail: clip(call.command) }];
}

function errorSignal(line: ClaudeToolLine & { ms: number }, at: string, nextMs: number | undefined): LogSignal | null {
  if (line.kind !== "tool_result") return null;
  const text = resultText(line.output);
  if (line.isError !== true && !DENIAL_TEXT.test(text)) return null;
  const cls = classifyError(text);
  const hours = nextMs === undefined ? 0 : hoursOf(Math.min(nextMs - line.ms, REACTION_CAP_MS));
  return { cluster: ERROR_CLUSTER[cls] ?? "other", kind: DENIAL_CLASSES.has(cls) ? "denial" : "tool-error", at, hours, detail: cls };
}

/** A spawner's brief fix or correction to its worker (Q6's classes) says the brief lacked something. */
export function followUpSignals(messages: readonly { at: string; body: string }[]): LogSignal[] {
  return messages.flatMap(({ at, body }) => {
    const cls = classifyFollowUp(body);
    return cls === "brief-fix" || cls === "correction" ? [{ cluster: "missing-context" as const, kind: "follow-up" as const, at, hours: 0, detail: cls }] : [];
  });
}
