import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { acceptVerdict, isUsageLimit, USAGE_LIMIT_REASON } from "./accept-verdict.js";
import { FINDINGS_SEPARATOR } from "./fix-first-findings.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";
import { MALFORMED_REFUSALS, readMalformed } from "./verdict-schemas.js";

const HEAD = "c".repeat(40);
const DISPATCHED_AT = 1_000_000;
const input: AwaitVerdictInput = { repo: "octo/demo", pr: 7, head: HEAD, reviewerAgentId: "reviewer-1", reviewerSessionId: "session-1", dispatchedAt: DISPATCHED_AT };
const locator = { source: { conversation: { nativeId: "session-1" } }, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } } as unknown as SourceTextLocator;
const verdictMessage = (writtenAt: number): ReviewerMessage => ({
  agentId: "reviewer-1",
  sessionId: "session-1",
  writtenAt,
  text: `Looked at it.\n\nVerdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`,
  locator,
});

describe("acceptVerdict malformed record", () => {
  const WRITTEN_AT = DISPATCHED_AT + 5_000;
  const said = (text: string, overrides: Partial<ReviewerMessage> = {}): ReviewerMessage => ({ ...verdictMessage(WRITTEN_AT), text, ...overrides });
  const block = (verdict: string, pr: string, head: string) => `Verdict: ${verdict}\n${pr}\n${head}\n`;
  const goodPr = "PR: octo/demo#7";
  const goodHead = `Head: ${HEAD}`;

  it.each([
    ["no_block", "I reviewed it and it looks fine."],
    ["multiple_blocks", `${block("MERGE", goodPr, goodHead)}\n${block("MERGE", goodPr, goodHead)}`],
    ["bad_verdict", block("APPROVE", goodPr, goodHead)],
    ["missing_pr_line", `Verdict: MERGE\n${goodHead}\n`],
    ["bad_pr", block("MERGE", "PR: demo#7", goodHead)],
    ["missing_head_line", `Verdict: MERGE\n${goodPr}\n`],
    ["bad_head", block("MERGE", goodPr, "Head: abc123")],
    ["wrong_target", block("MERGE", "PR: octo/other#7", goodHead)],
    ["wrong_target", block("MERGE", "PR: octo/demo#8", goodHead)],
    ["wrong_target", block("MERGE", goodPr, `Head: ${"d".repeat(40)}`)],
  ])("records %s when the final message is malformed", (refusal, text) => {
    const result = acceptVerdict(input, [said(text)]);

    expect(result).toEqual({ kind: "none", malformed: { refusal, writtenAt: WRITTEN_AT } });
    expect(readMalformed(result)).toEqual({ refusal, writtenAt: WRITTEN_AT });
  });

  it("reads Claude Code's own weekly-limit record as a usage limit with its recorded reset, not a missing Verdict line", () => {
    const notice = "You've hit your weekly limit \u00b7 resets Oct 10 at 6pm (America/Denver)";
    const resetsAt = Date.parse("2026-10-11T00:00:00Z");

    const result = acceptVerdict(input, [said(notice, { synthetic: { apiError: "rate_limit", resetsAt } })]);

    expect(result).toEqual({ kind: "none", reason: USAGE_LIMIT_REASON, notice, resetsAt });
    expect(isUsageLimit(result)).toBe(true);
    expect(readMalformed(result)).toBeNull();
  });

  it("reads the same words written by the reviewer itself as a malformed verdict, never a limit", () => {
    const notice = "You've hit your weekly limit \u00b7 resets Oct 10 at 6pm (America/Denver)";

    expect(acceptVerdict(input, [said(notice)])).toEqual({ kind: "none", malformed: { refusal: "no_block", writtenAt: WRITTEN_AT } });
  });

  it("reads a client-written record that names another API error as a malformed verdict", () => {
    const notice = "You've hit your weekly limit";

    expect(acceptVerdict(input, [said(notice, { synthetic: { apiError: "overloaded_error", resetsAt: null } })])).toEqual({ kind: "none", malformed: { refusal: "no_block", writtenAt: WRITTEN_AT } });
  });

  it("still records a review that merely quotes a limit as malformed", () => {
    const review = `I looked at it. The reviewer note says: You've hit your weekly limit. ${"x".repeat(400)}`;

    expect(acceptVerdict(input, [said(review)])).toEqual({ kind: "none", malformed: { refusal: "no_block", writtenAt: WRITTEN_AT } });
  });

  it("covers every refusal the schema lists", () => {
    const exercised = new Set(["no_block", "multiple_blocks", "bad_verdict", "missing_pr_line", "bad_pr", "missing_head_line", "bad_head", "wrong_target"]);

    expect(new Set(Object.keys(MALFORMED_REFUSALS))).toEqual(exercised);
  });

  it("records nothing for silence", () => {
    expect(acceptVerdict(input, [])).toEqual({ kind: "none" });
  });

  it("records nothing for another session's message", () => {
    const foreign = said("no verdict here", { sessionId: "session-2", agentId: "reviewer-2" });

    expect(acceptVerdict(input, [foreign])).toEqual({ kind: "none" });
  });

  it("records nothing for a message written before dispatch", () => {
    const early = said("no verdict here", { writtenAt: DISPATCHED_AT - 1 });

    expect(acceptVerdict(input, [early])).toEqual({ kind: "none" });
  });

  it("records nothing when only an earlier message was malformed", () => {
    const earlier = said("rambling", { writtenAt: WRITTEN_AT - 1 });

    expect(acceptVerdict(input, [earlier, verdictMessage(WRITTEN_AT)]).kind).toBe("verdict");
  });

  it("records nothing for WAIT", () => {
    const result = acceptVerdict(input, [said(block("WAIT", goodPr, goodHead))]);

    expect(result).toEqual({ kind: "none", reason: "wait" });
  });
});

describe("acceptVerdict FIX_FIRST findings", () => {
  const OLD_HEAD = "d".repeat(40);
  const fixFirst = (head: string) => `Verdict: FIX_FIRST\nPR: octo/demo#7\nHead: ${head}`;
  const VERDICT = `1. The parser drops the last token.\n\n${fixFirst(HEAD)}`;
  const POSTSCRIPT = `A background search hit its time limit and was stopped. The verdict stands.\n\n${fixFirst(HEAD)}`;
  const said = (text: string, writtenAt: number): ReviewerMessage => ({ ...verdictMessage(writtenAt), text });
  const findingsOf = (result: ReturnType<typeof acceptVerdict>) => (result.kind === "verdict" && result.verdict === "FIX_FIRST" ? result.text : undefined);

  it("keeps the verdict's findings when a postscript restating the block follows it", () => {
    const result = acceptVerdict(input, [said(VERDICT, DISPATCHED_AT + 1), said(POSTSCRIPT, DISPATCHED_AT + 2)]);

    expect(findingsOf(result)).toBe(`${VERDICT}${FINDINGS_SEPARATOR}${POSTSCRIPT}`);
  });

  it("hands over every finding when a later FIX_FIRST adds one, in order and once each", () => {
    const fuller = `1. The parser drops the last token.\n2. The cache key ignores the locale.\n\n${fixFirst(HEAD)}`;

    const result = acceptVerdict(input, [said(VERDICT, DISPATCHED_AT + 1), said(VERDICT, DISPATCHED_AT + 2), said(fuller, DISPATCHED_AT + 3)]);

    expect(findingsOf(result)).toBe(`${VERDICT}${FINDINGS_SEPARATOR}${fuller}`);
  });

  it("never hands over a verdict written for an older head", () => {
    const older = said(`1. Stale finding.\n\n${fixFirst(OLD_HEAD)}`, DISPATCHED_AT + 1);

    const result = acceptVerdict(input, [older, said(POSTSCRIPT, DISPATCHED_AT + 2)]);

    expect(findingsOf(result)).toBe(POSTSCRIPT);
  });

  it("never hands over a verdict written before the dispatch", () => {
    const early = said(VERDICT, DISPATCHED_AT - 1);

    const result = acceptVerdict(input, [early, said(fixFirst(HEAD), DISPATCHED_AT + 2)]);

    expect(findingsOf(result)).toBe(fixFirst(HEAD));
  });
});
