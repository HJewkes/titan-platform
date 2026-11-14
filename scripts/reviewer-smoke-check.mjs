import { classifyDeniedAction } from "../packages/session-analytics/dist/index.js";
import { claudeSourceFromPath, parseVerdictBlock, readSessionObservations } from "../packages/session-read/dist/index.js";
import { finishedTurnMessages } from "../products/factory/dist/shepherd/reviewer-reader.js";

const REVIEWER_ID = "smoke-reviewer";
const NAMESPACE = "smoke";

/**
 * The three ways a reviewer's tool call is refused rather than run. An ordinary non-zero exit
 * is an error the reviewer can work around, so it is reported apart and never fails the smoke.
 */
const REFUSALS = [
  ["deny-list", /^(?:Error: )?Permission to use \S+ .*has been denied/s],
  ["hook-deadline", /permission-hook deadline/],
  ["classifier", /denied by the Claude Code auto mode classifier/],
];

/** Which refusal a tool_result's text is, or null for any other result. */
export function refusalKind(text) {
  return REFUSALS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function namesTarget(block, target) {
  return block.repo === target.repo && block.pr === target.pr && block.head === target.head;
}

/** A WAIT is a delivered block too; only a block naming another target, or none, is no verdict. */
function verdictIn(message, target) {
  const block = parseVerdictBlock(message.text);
  if (!block.ok && block.reason !== "wait") return null;
  if (!namesTarget(block, target)) return null;
  return { verdict: block.ok ? block.verdict : "WAIT", via: message.via };
}

/** Shepherd reads assistant text and chat_send `text` inputs alike; only the input locator tells them apart. */
const viaOf = (message) => (message.locator.selector.path.includes("input") ? "chat_send" : "text");

/**
 * Reads the transcript through Shepherd's own `finishedTurnMessages`, so what counts as a delivered turn is
 * decided there. Only tool calls and the failed results this smoke reports on are collected locally.
 */
async function scan(transcriptPath) {
  const turn = finishedTurnMessages(REVIEWER_ID);
  const calls = new Map();
  const results = [];
  for await (const observation of readSessionObservations(claudeSourceFromPath(transcriptPath, NAMESPACE))) {
    turn.add(observation);
    if (observation.kind === "tool_call") calls.set(observation.call.nativeId, { tool: observation.name, input: observation.input });
    if (observation.kind === "tool_result" && observation.isError === true) results.push(observation);
  }
  const written = turn.result().map((message) => ({ via: viaOf(message), text: message.text }));
  return { calls, written, finished: written.length > 0, results };
}

function failedCall(result, calls) {
  const call = calls.get(result.call.nativeId) ?? { tool: "unknown", input: null };
  const text = resultText(result.output);
  return { tool: call.tool, action: classifyDeniedAction(call.tool, call.input), text: text.slice(0, 300), kind: refusalKind(text) };
}

/**
 * Reads a reviewer transcript file for the verdict it delivered on `target` and every
 * tool call that was refused or prompted. `ok` is the smoke's pass condition.
 */
export async function checkReviewerTranscript(transcriptPath, target) {
  const { calls, written, finished, results } = await scan(transcriptPath);
  const verdict = written.map((message) => verdictIn(message, target)).filter(Boolean).at(-1) ?? null;
  const failed = results.map((result) => failedCall(result, calls));
  const refusals = failed.filter((call) => call.kind !== null);
  const errors = failed.filter((call) => call.kind === null).map(({ kind: _kind, ...call }) => call);
  return { ok: verdict !== null && refusals.length === 0, finishedTurn: finished, verdict, refusals, errors };
}
