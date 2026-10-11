import { classifyDeniedAction } from "../packages/session-analytics/dist/index.js";
import { parseVerdictBlock } from "../packages/session-read/dist/index.js";

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

function parseRecord(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Shepherd reads both assistant text and chat_send `text` inputs as a reviewer's verdict (reviewer-reader.ts). */
function writtenMessage(part) {
  if (part.type === "text" && typeof part.text === "string") return { via: "text", text: part.text };
  if (part.type === "tool_use" && part.name?.endsWith("chat_send") && typeof part.input?.text === "string") return { via: "chat_send", text: part.input.text };
  return null;
}

function blocksOf(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content.filter((part) => part && typeof part === "object") : [];
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

function scan(lines) {
  const calls = new Map();
  const written = [];
  const results = [];
  for (const line of lines) {
    const record = parseRecord(line);
    for (const part of blocksOf(record)) {
      if (part.type === "tool_use") calls.set(part.id, { tool: part.name, input: part.input });
      if (part.type === "tool_result" && part.is_error === true) results.push(part);
      const message = record.type === "assistant" ? writtenMessage(part) : null;
      if (message) written.push(message);
    }
  }
  return { calls, written, results };
}

function failedCall(result, calls) {
  const call = calls.get(result.tool_use_id) ?? { tool: "unknown", input: null };
  const text = resultText(result.content);
  return { tool: call.tool, action: classifyDeniedAction(call.tool, call.input), text: text.slice(0, 300), kind: refusalKind(text) };
}

/**
 * Reads a reviewer transcript (JSONL lines) for the verdict it delivered on `target` and every
 * tool call that was refused or prompted. `ok` is the smoke's pass condition.
 */
export function checkReviewerTranscript(lines, target) {
  const { calls, written, results } = scan(lines);
  const verdict = written.map((message) => verdictIn(message, target)).filter(Boolean).at(-1) ?? null;
  const failed = results.map((result) => failedCall(result, calls));
  const refusals = failed.filter((call) => call.kind !== null);
  const errors = failed.filter((call) => call.kind === null).map(({ kind: _kind, ...call }) => call);
  return { ok: verdict !== null && refusals.length === 0, verdict, refusals, errors };
}
