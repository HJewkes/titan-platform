import type { LineContext, LineReader } from "./line-reader.js";
import { RELATIONS, agentRef, sessionRef } from "./refs.js";
import { asObject, blocks, int, str, type Json } from "./text.js";

/** A `user` line is either a prompt or the tool results for the previous assistant turn. */
export function readUserLine(reader: LineReader, ctx: LineContext): void {
  const message = asObject(ctx.line.message);
  const content = message?.content;
  const isPrompt = typeof content === "string" || blocks(message).some((b) => b.type === "text");
  if (isPrompt) return readPrompt(reader, ctx);

  const errored = blocks(message).some((b) => b.type === "tool_result" && b.is_error === true);
  reader.fact(ctx, errored ? "tool_result_error" : "tool_result");
  reader.span(ctx, "tool_result");
  linkDispatchedSubagent(reader, ctx, message);
  recordPrCreateResult(reader, ctx, message);
}

function readPrompt(reader: LineReader, ctx: LineContext): void {
  reader.fact(ctx, "user_prompt");
  reader.span(ctx, "prompt");
  const promptId = str(ctx.line, "uuid");
  if (promptId) reader.emit({ ...reader.base(ctx), kind: "turn", promptId });
}

function resultToolUseId(message: Json | null): string | null {
  return str(blocks(message).find((b) => b.type === "tool_result") ?? null, "tool_use_id");
}

/**
 * An async `Agent` dispatch answers with `toolUseResult.agentId`, naming the
 * subagent's transcript and hence the session it is indexed under. This line is
 * the only place the dispatch id and the child session are stated together.
 */
function linkDispatchedSubagent(reader: LineReader, ctx: LineContext, message: Json | null): void {
  const agentId = str(asObject(ctx.line.toolUseResult), "agentId");
  const toolUseId = resultToolUseId(message);
  if (!agentId || !toolUseId) return;
  reader.edge(ctx, agentRef(toolUseId), RELATIONS.TRANSCRIBED_IN, sessionRef(agentId));
  reader.emit({ ...reader.base(ctx), kind: "subagent_transcript", agentRef: agentRef(toolUseId), childSessionId: agentId });
}

/**
 * The result half of a `gh pr create`: `toolUseResult.gitOperation.pr` is
 * structured, so the number is read rather than scraped, and `action`
 * separates a creation from edits, comments, merges, and closes.
 */
function recordPrCreateResult(reader: LineReader, ctx: LineContext, message: Json | null): void {
  const created = asObject(asObject(asObject(ctx.line.toolUseResult)?.gitOperation)?.pr);
  if (!created || str(created, "action") !== "created") return;
  const number = int(created, "number");
  const url = str(created, "url");
  const repo = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(url ?? "")?.[1];
  const toolUseId = resultToolUseId(message);
  if (!toolUseId || !repo || number <= 0) return;
  reader.emit({ ...reader.base(ctx), kind: "pr_create", toolUseId, title: null, number, repo, url });
}
