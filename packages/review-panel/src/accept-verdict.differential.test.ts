import { readFileSync } from "node:fs";
import { parseVerdictBlock } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { acceptVerdict, isUsageLimit } from "./accept-verdict.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";

// The oracle is Shepherd's acceptVerdict and its helpers as they stood before the move, frozen here so a later edit to the
// package shows up as a diff against them. Nothing outside this file may import it.
const oracle = (() => {
  const OWNER_BRIEF_START = "OWNER-BRIEF";
  const OWNER_BRIEF_END = "END-OWNER-BRIEF";
  const MAX_OWNER_BRIEF_CHARS = 2000;
  const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
  const FIX_FIRST_TRUNCATED = "[earlier findings truncated]\n";
  const FINDINGS_SEPARATOR = "\n\n---\n\n";
  const BLOCK_LINE = /^\s*(?:Verdict|PR|Head|Closer):/;
  const USAGE_LIMIT_REASON = "the reviewer hit the account usage limit and wrote no review";
  const USAGE_LIMIT_NOTICE = /^You've hit your [\w -]{0,24}limit\b/;
  const DEPTH_FLOOR_REASON = "below the review depth floor: the reviewer made no investigative tool call before its verdict";
  type Target = { repo: string; pr: number; head: string };

  const namesTarget = (block: Target, target: Target): boolean => block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr && block.head === target.head;
  const isUsageLimitNotice = (text: string): boolean => text.length <= 200 && USAGE_LIMIT_NOTICE.test(text.trim());
  const findingsText = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !BLOCK_LINE.test(line))
      .join("\n")
      .trim();
  function boundedFindings(text: string, max = MAX_FIX_FIRST_TEXT_CHARS): string {
    if (text.length <= max) return text;
    return FIX_FIRST_TRUNCATED + text.slice(text.length - (max - FIX_FIRST_TRUNCATED.length));
  }
  function isFixFirstAt(target: Target, text: string): boolean {
    const block = parseVerdictBlock(text);
    return "repo" in block && block.ok && block.verdict === "FIX_FIRST" && namesTarget(block, target);
  }
  function fixFirstFindings(target: Target, messages: readonly ReviewerMessage[], fallback: string): string {
    const said = messages.filter((message) => Number.isFinite(message.writtenAt) && findingsText(message.text) !== "" && isFixFirstAt(target, message.text));
    const texts = [...new Set([...said].sort((a, b) => a.writtenAt - b.writtenAt).map((message) => message.text))];
    return boundedFindings(texts.length === 0 ? fallback : texts.join(FINDINGS_SEPARATOR), MAX_FIX_FIRST_TEXT_CHARS);
  }

  const Bullets = z.array(z.string().min(1).max(300)).min(1).max(5);
  const OwnerBriefSchema = z.strictObject({ what: z.string().min(1).max(500), why: z.string().min(1).max(500), pros: Bullets, cons: Bullets, doorType: z.enum(["two-way", "one-way"]) });
  type Draft = { what?: string; why?: string; door?: string; pros: string[]; cons: string[] };
  function takeLine(draft: Draft, line: string, list: { current: string[] | null }): boolean {
    if (line === "") return true;
    const single = /^(What|Why|Door): (.+)$/.exec(line);
    if (single) {
      const key = single[1] === "What" ? "what" : single[1] === "Why" ? "why" : "door";
      if (draft[key] !== undefined) return false;
      draft[key] = single[2]!;
      list.current = null;
      return true;
    }
    if (line === "Pros:" || line === "Cons:") return (list.current = line === "Pros:" ? draft.pros : draft.cons), true;
    const bullet = /^- (.+)$/.exec(line);
    if (!bullet || list.current === null) return false;
    list.current.push(bullet[1]!);
    return true;
  }
  function parseOwnerBrief(text: string) {
    const lines = text.split("\n").map((line) => line.trim());
    const verdictAt = lines.findIndex((line) => line.startsWith("Verdict:"));
    const starts = lines.flatMap((line, index) => (index > verdictAt && verdictAt >= 0 && line === OWNER_BRIEF_START ? [index] : []));
    if (starts.length !== 1) return null;
    const end = lines.indexOf(OWNER_BRIEF_END, starts[0]);
    const body = lines.slice(starts[0]! + 1, end < 0 ? undefined : end);
    if (body.join("\n").length > MAX_OWNER_BRIEF_CHARS) return null;
    const draft: Draft = { pros: [], cons: [] };
    const list = { current: null as string[] | null };
    if (!body.every((line) => takeLine(draft, line, list))) return null;
    const parsed = OwnerBriefSchema.safeParse({ what: draft.what, why: draft.why, pros: draft.pros, cons: draft.cons, doorType: draft.door });
    return parsed.success ? parsed.data : null;
  }

  const fromDispatch = (input: AwaitVerdictInput, message: ReviewerMessage): boolean =>
    message.agentId === input.reviewerAgentId && message.sessionId === input.reviewerSessionId && message.writtenAt > input.dispatchedAt;
  const malformedNone = (refusal: string, writtenAt: number) => ({ kind: "none", malformed: { refusal, writtenAt } });

  return function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): unknown {
    const final = messages.at(-1);
    if (!final) return { kind: "none" };
    if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
    if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
    if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
    if (messages.some((earlier) => earlier.writtenAt > final.writtenAt)) return { kind: "none" };
    if (isUsageLimitNotice(final.text)) return { kind: "none", reason: USAGE_LIMIT_REASON };
    const block = parseVerdictBlock(final.text);
    if (!("repo" in block)) return malformedNone(block.reason, final.writtenAt);
    if (!namesTarget(block, input)) return malformedNone("wrong_target", final.writtenAt);
    if (!block.ok) return { kind: "none", reason: "wait" };
    if (final.investigativeCalls === 0) return { kind: "none", reason: DEPTH_FLOOR_REASON };
    const accepted = { kind: "verdict", head: block.head, locator: final.locator, reviewer: { agentId: final.agentId, sessionId: final.sessionId }, ownerBrief: parseOwnerBrief(final.text) };
    return block.verdict === "MERGE"
      ? { ...accepted, verdict: "MERGE" }
      : { ...accepted, verdict: "FIX_FIRST", text: fixFirstFindings(input, messages.filter((message) => fromDispatch(input, message)), final.text), ...(block.closer && { closer: block.closer }) };
  };
})();

interface RecordedCase {
  name: string;
  input: AwaitVerdictInput;
  messages: ReviewerMessage[];
}

const cases: RecordedCase[] = JSON.parse(readFileSync(new URL("./__fixtures__/verdict-messages.json", import.meta.url), "utf8"));

describe("acceptVerdict against the frozen Shepherd copy", () => {
  it.each(cases.map((recorded) => [recorded.name, recorded] as const))("decides %s exactly as before the move", (_name, recorded) => {
    const before = oracle(recorded.input, recorded.messages);

    const after = acceptVerdict(recorded.input, recorded.messages);

    // Since TP-1955 a limit result also keeps the client's notice, which the frozen copy dropped.
    expect(after).toStrictEqual(isUsageLimit(after) ? { ...before, notice: recorded.messages.at(-1)?.text.trim() } : before);
  });

  it("covers every outcome the acceptor can reach", () => {
    const outcomes = new Set(cases.map((recorded) => JSON.stringify(oracle(recorded.input, recorded.messages), ["kind", "verdict", "reason", "malformed", "refusal"])));

    expect(outcomes.size).toBeGreaterThanOrEqual(14);
  });
});
