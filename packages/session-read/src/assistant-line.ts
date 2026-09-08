import { commandCwd, parseGitIntent, parsePrCreateTitle, parseTaskId, realCommand, type GitIntent } from "./bash-parse.js";
import type { LineContext, LineReader } from "./line-reader.js";
import { RELATIONS, agentRef, branchRef, repoForCwd, sessionRef, taskRef } from "./refs.js";
import { asObject, blocks, int, str, thinkingTokens, type Json } from "./text.js";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);

export function readAssistantLine(reader: LineReader, ctx: LineContext): void {
  const message = asObject(ctx.line.message);
  const content = blocks(message);
  const toolUses = content.filter((b) => b.type === "tool_use");
  reader.fact(ctx, toolUses.length > 0 ? "tool_decision" : "assistant_response", str(toolUses[0] ?? null, "id"));
  reader.session(ctx, {}, { turn: 1 });
  recordUsage(reader, ctx, message);
  if (content.some((b) => b.type === "text")) reader.span(ctx, "assistant_response");
  if (toolUses.length > 0) reader.span(ctx, "tool_input");
  for (const block of toolUses) readToolUse(reader, ctx, block);
}

function recordUsage(reader: LineReader, ctx: LineContext, message: Json | null): void {
  const usage = asObject(message?.usage);
  const model = str(message, "model");
  if (!usage || !model) return;
  const outputTokens = int(usage, "output_tokens");
  reader.emit({
    ...reader.base(ctx),
    kind: "usage",
    model,
    inputTokens: int(usage, "input_tokens"),
    outputTokens,
    cacheReadTokens: int(usage, "cache_read_input_tokens"),
    cacheCreationTokens: int(usage, "cache_creation_input_tokens"),
    thinkingTokens: thinkingTokens(message, outputTokens),
  });
}

function readToolUse(reader: LineReader, ctx: LineContext, block: Json): void {
  const name = str(block, "name");
  const input = asObject(block.input);
  if (!name) return;
  if (FILE_TOOLS.has(name)) {
    const raw = str(input, "file_path") ?? str(input, "notebook_path");
    if (raw) reader.recordFile(ctx, raw, RELATIONS.TOUCHED);
    return;
  }
  if (name === "Agent") return readAgent(reader, ctx, block, input);
  if (name === "Artifact") return readArtifact(reader, ctx, block, input);
  if (name === "Bash") return readBash(reader, ctx, block, input);
}

function readAgent(reader: LineReader, ctx: LineContext, block: Json, input: Json | null): void {
  const toolUseId = str(block, "id");
  if (!toolUseId) return;
  const ref = agentRef(toolUseId);
  reader.emit({ ...reader.base(ctx), kind: "subagent", agentRef: ref, agentType: str(input, "subagent_type"), label: str(input, "description") });
  reader.edge(ctx, sessionRef(ctx.sessionId), RELATIONS.SPAWNED, ref);
}

function readArtifact(reader: LineReader, ctx: LineContext, block: Json, input: Json | null): void {
  const toolUseId = str(block, "id");
  if (!toolUseId) return;
  reader.recordArtifact(ctx, toolUseId, "artifact", { title: str(input, "description"), url: null, path: str(input, "file_path") });
}

function readBash(reader: LineReader, ctx: LineContext, block: Json, input: Json | null): void {
  const raw = str(input, "command");
  if (!raw) return;
  const git = parseGitIntent(raw);
  // A git verb is attributed to the directory it runs in, which `cd` or `git -C` can move.
  if (git) recordGitIntent(reader, ctx, git, repoForCwd(commandCwd(raw, ctx.cwd)));
  const title = parsePrCreateTitle(raw);
  const toolUseId = str(block, "id");
  if (title && toolUseId) reader.emit({ ...reader.base(ctx), kind: "pr_create", toolUseId, title, number: null, repo: null, url: null });
  const taskId = parseTaskId(realCommand(raw));
  if (taskId) {
    reader.emit({ ...reader.base(ctx), kind: "task", taskRef: taskRef(taskId), taskId });
    reader.edge(ctx, sessionRef(ctx.sessionId), RELATIONS.RAN, taskRef(taskId));
  }
}

function recordGitIntent(reader: LineReader, ctx: LineContext, git: GitIntent, repo: string | null): void {
  if (git.setBranch) reader.recordBranch(ctx, git.setBranch, repo, git.branchBase);
  if (git.deletedBranch) {
    reader.emit({ ...reader.base(ctx), kind: "branch", branchRef: branchRef(repo, git.deletedBranch), repo, name: git.deletedBranch, base: null, deleted: true });
  }
  if (git.commit || git.push) reader.session(ctx, {}, { commit: git.commit ? 1 : 0, push: git.push ? 1 : 0 });
  if (git.mergedPr) reader.emit({ ...reader.base(ctx), kind: "pr_merge", number: git.mergedPr, repoHint: repo });
}
