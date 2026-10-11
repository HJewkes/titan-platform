import { describe, expect, it } from "vitest";
import { checkReviewerTranscript, refusalKind } from "./reviewer-smoke-check.mjs";

const HEAD = "702e4c8f".padEnd(40, "0");
const TARGET = { repo: "HJewkes/titan-platform", pr: 343, head: HEAD };
const SEND = "mcp__plugin_agent-chat_agent-chat__chat_send";
const BLOCK =`Looks right.\n\nVerdict: MERGE\nPR: HJewkes/titan-platform#343\nHead: ${HEAD}`;

const assistant = (...content) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const user = (...content) => JSON.stringify({ type: "user", message: { role: "user", content } });
const text = (value) => ({ type: "text", text: value });
const call = (id, name, input) => ({ type: "tool_use", id, name, input });
const failure = (id, content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
const bash = (id, command) => assistant(call(id, "Bash", { command }));

describe("checkReviewerTranscript", () => {
  it("finds the verdict a reviewer wrote in its last assistant text", () => {
    const report = checkReviewerTranscript([user(text("brief")), assistant(text(BLOCK))], TARGET);

    expect(report).toMatchObject({ ok: true, verdict: { verdict: "MERGE", via: "text" }, refusals: [] });
  });

  it("finds the verdict a reviewer sent with chat_send when its turn then ends on text", () => {
    const lines = [assistant(call("t1", SEND, { to: "shepherd", text: BLOCK })), user({ type: "tool_result", tool_use_id: "t1", content: "Delivered" }), assistant(text("Sent."))];

    expect(checkReviewerTranscript(lines, TARGET).verdict).toEqual({ verdict: "MERGE", via: "chat_send" });
  });

  it("reports no verdict when the turn ends on the chat_send call", () => {
    expect(checkReviewerTranscript([assistant(call("t1", SEND, { to: "shepherd", text: BLOCK }))], TARGET).verdict).toBeNull();
  });

  it("reports no verdict when a tool call follows the verdict, as Shepherd's reader does", () => {
    const lines = [assistant(text(BLOCK)), bash("t1", 'rm -rf "/checkouts/review-343"')];

    expect(checkReviewerTranscript(lines, TARGET)).toMatchObject({ ok: false, finishedTurn: false, verdict: null });
  });

  it("reports no verdict when a thinking-only record follows the verdict", () => {
    const lines = [assistant(text(BLOCK)), assistant({ type: "thinking", thinking: "done" })];

    expect(checkReviewerTranscript(lines, TARGET).verdict).toBeNull();
  });

  it("ignores bookkeeping records after the final text", () => {
    const lines = [assistant(text(BLOCK)), JSON.stringify({ type: "system", subtype: "turn_duration" }), JSON.stringify({ type: "summary", summary: "Review" })];

    expect(checkReviewerTranscript(lines, TARGET)).toMatchObject({ ok: true, finishedTurn: true });
  });

  it("reports no verdict when the block names another head", () => {
    const other = BLOCK.replace(HEAD, "a".repeat(40));

    const report = checkReviewerTranscript([assistant(text(other))], TARGET);

    expect(report).toMatchObject({ ok: false, verdict: null });
  });

  it("reports no verdict when the reviewer never wrote a block", () => {
    expect(checkReviewerTranscript([assistant(text("I reviewed it and it is fine."))], TARGET).verdict).toBeNull();
  });

  it("does not read the brief's own template as the verdict", () => {
    expect(checkReviewerTranscript([user(text(BLOCK))], TARGET).verdict).toBeNull();
  });

  it("counts a deny-list refusal", () => {
    const lines = [bash("t1", "git stash list"), user(failure("t1", "Permission to use Bash with command git stash list has been denied.")), assistant(text(BLOCK))];

    const report = checkReviewerTranscript(lines, TARGET);

    expect(report.ok).toBe(false);
    expect(report.refusals).toEqual([expect.objectContaining({ kind: "deny-list", tool: "Bash", action: "bash-other" })]);
  });

  it("counts a permission-hook deadline as a refusal, also when the result is a text-part array", () => {
    const deadline = [text("The owner did not answer in time (agent-chat permission-hook deadline).")];
    const lines = [bash("t1", "sed -i s/a/b/ src/x.ts"), user(failure("t1", deadline)), assistant(text(BLOCK))];

    expect(checkReviewerTranscript(lines, TARGET).refusals).toEqual([expect.objectContaining({ kind: "hook-deadline", action: "file-write" })]);
  });

  it("counts an auto mode classifier refusal", () => {
    const denied = "Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]";
    const lines = [bash("t1", "gh pr merge 343"), user(failure("t1", denied))];

    expect(checkReviewerTranscript(lines, TARGET).refusals[0]).toMatchObject({ kind: "classifier", action: "merge" });
  });

  it("does not count an ordinary non-zero exit as a refusal", () => {
    const lines = [bash("t1", "pnpm exec vitest run x"), user(failure("t1", "Exit code 1\nFAIL x.test.ts")), assistant(text(BLOCK))];

    const report = checkReviewerTranscript(lines, TARGET);

    expect(report).toMatchObject({ ok: true, refusals: [] });
    expect(report.errors).toEqual([expect.objectContaining({ tool: "Bash", text: expect.stringContaining("Exit code 1") })]);
  });

  it("skips lines that are not JSON", () => {
    expect(checkReviewerTranscript(["{truncated", assistant(text(BLOCK))], TARGET).ok).toBe(true);
  });
});

describe("refusalKind", () => {
  it("reads the prefixed form the hook writes into toolUseResult", () => {
    expect(refusalKind("Error: Permission to use Bash with command agent-chat agent ls --json has been denied.")).toBe("deny-list");
  });
});
