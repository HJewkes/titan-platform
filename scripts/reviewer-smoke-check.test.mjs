import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReviewerTranscript as checkTranscriptFile, refusalKind } from "./reviewer-smoke-check.mjs";

const HEAD = "702e4c8f".padEnd(40, "0");
const TARGET = { repo: "HJewkes/titan-platform", pr: 343, head: HEAD };
const SEND = "mcp__plugin_agent-chat_agent-chat__chat_send";
const BLOCK =`Looks right.\n\nVerdict: MERGE\nPR: HJewkes/titan-platform#343\nHead: ${HEAD}`;

const SESSION = "11111111-2222-4333-8444-555555555555";
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Writes the lines as a transcript file, because the check reads through Shepherd's file reader. */
async function checkReviewerTranscript(lines, target, partialTail = "") {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-smoke-"));
  dirs.push(dir);
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, lines.map((line) => `${line}\n`).join("") + partialTail);
  return checkTranscriptFile(file, target);
}

let sequence = 0;
const stamp = (record) => ({ uuid: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, sessionId: SESSION, timestamp: "2026-01-01T00:00:00.000Z", ...record });
const assistant = (...content) => JSON.stringify(stamp({ type: "assistant", message: { role: "assistant", content } }));
const user = (...content) => JSON.stringify(stamp({ type: "user", message: { role: "user", content } }));
const text = (value) => ({ type: "text", text: value });
const call = (id, name, input) => ({ type: "tool_use", id, name, input });
const failure = (id, content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
const bash = (id, command) => assistant(call(id, "Bash", { command }));

describe("checkReviewerTranscript", () => {
  it("finds the verdict a reviewer wrote in its last assistant text", async () => {
    const report = await checkReviewerTranscript([user(text("brief")), assistant(text(BLOCK))], TARGET);

    expect(report).toMatchObject({ ok: true, verdict: { verdict: "MERGE", via: "text" }, refusals: [] });
  });

  it("finds the verdict a reviewer sent with chat_send when its turn then ends on text", async () => {
    const lines = [assistant(call("t1", SEND, { to: "shepherd", text: BLOCK })), user({ type: "tool_result", tool_use_id: "t1", content: "Delivered" }), assistant(text("Sent."))];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report.verdict).toEqual({ verdict: "MERGE", via: "chat_send" });
  });

  it("reports no verdict when the turn ends on the chat_send call", async () => {
    const report = await checkReviewerTranscript([assistant(call("t1", SEND, { to: "shepherd", text: BLOCK }))], TARGET);

    expect(report.verdict).toBeNull();
  });

  it("reports no verdict when a tool call follows the verdict, as Shepherd's reader does", async () => {
    const lines = [assistant(text(BLOCK)), bash("t1", 'rm -rf "/checkouts/review-343"')];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report).toMatchObject({ ok: false, finishedTurn: false, verdict: null });
  });

  it("reports no verdict when a thinking-only record follows the verdict", async () => {
    const lines = [assistant(text(BLOCK)), assistant({ type: "thinking", thinking: "done" })];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report.verdict).toBeNull();
  });

  it("ignores bookkeeping records after the final text", async () => {
    const lines = [assistant(text(BLOCK)), JSON.stringify(stamp({ type: "system", subtype: "turn_duration" })), JSON.stringify({ type: "summary", summary: "Review" })];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report).toMatchObject({ ok: true, finishedTurn: true });
  });

  it("reports no verdict when the block names another head", async () => {
    const other = BLOCK.replace(HEAD, "a".repeat(40));

    const report = await checkReviewerTranscript([assistant(text(other))], TARGET);

    expect(report).toMatchObject({ ok: false, verdict: null });
  });

  it("reports no verdict when the reviewer never wrote a block", async () => {
    const report = await checkReviewerTranscript([assistant(text("I reviewed it and it is fine."))], TARGET);

    expect(report.verdict).toBeNull();
  });

  it("does not read the brief's own template as the verdict", async () => {
    const report = await checkReviewerTranscript([user(text(BLOCK))], TARGET);

    expect(report.verdict).toBeNull();
  });

  it("counts a deny-list refusal", async () => {
    const lines = [bash("t1", "git stash list"), user(failure("t1", "Permission to use Bash with command git stash list has been denied.")), assistant(text(BLOCK))];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report.ok).toBe(false);
    expect(report.refusals).toEqual([expect.objectContaining({ kind: "deny-list", tool: "Bash", action: "bash-other" })]);
  });

  it("counts a permission-hook deadline as a refusal, also when the result is a text-part array", async () => {
    const deadline = [text("The owner did not answer in time (agent-chat permission-hook deadline).")];
    const lines = [bash("t1", "sed -i s/a/b/ src/x.ts"), user(failure("t1", deadline)), assistant(text(BLOCK))];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report.refusals).toEqual([expect.objectContaining({ kind: "hook-deadline", action: "file-write" })]);
  });

  it("counts an auto mode classifier refusal", async () => {
    const denied = "Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]";
    const lines = [bash("t1", "gh pr merge 343"), user(failure("t1", denied))];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report.refusals[0]).toMatchObject({ kind: "classifier", action: "merge" });
  });

  it("does not count an ordinary non-zero exit as a refusal", async () => {
    const lines = [bash("t1", "pnpm exec vitest run x"), user(failure("t1", "Exit code 1\nFAIL x.test.ts")), assistant(text(BLOCK))];

    const report = await checkReviewerTranscript(lines, TARGET);

    expect(report).toMatchObject({ ok: true, refusals: [] });
    expect(report.errors).toEqual([expect.objectContaining({ tool: "Bash", text: expect.stringContaining("Exit code 1") })]);
  });

  it("ignores a record still being written at the end of the file", async () => {
    const report = await checkReviewerTranscript([assistant(text(BLOCK))], TARGET, '{"type":"assis');

    expect(report.ok).toBe(true);
  });
});

describe("refusalKind", () => {
  it("reads the prefixed form the hook writes into toolUseResult", async () => {
    expect(refusalKind("Error: Permission to use Bash with command agent-chat agent ls --json has been denied.")).toBe("deny-list");
  });

  it("reads a deny-list refusal of a command that spans several lines", () => {
    expect(refusalKind("Error: Permission to use Bash with command gh-write <<'EOF'\nbody\nEOF has been denied.")).toBe("deny-list");
  });

  it("reads the was-denied wording as a deny-list refusal", () => {
    expect(refusalKind("The call was denied")).toBe("deny-list");
  });
});
