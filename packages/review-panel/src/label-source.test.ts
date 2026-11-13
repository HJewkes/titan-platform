import { partialFake } from "@titan-design/test-kit";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { labelSource } from "./label-source.js";
import type { ReviewerMessage } from "./ports.js";

const HEAD = "c".repeat(40);
const BLOCK = `Verdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\nCI-policy: unchanged`;
const REVIEW = `Read the diff and ran the suite. ${"Every branch is covered. ".repeat(20)}\nAttests: ci-wait@${"a".repeat(12)}\n\n${BLOCK}`;
const BARE_REPEAT = `I've removed the review checkout directory.\n\n${BLOCK}`;

const message = (writtenAt: number, text: string): ReviewerMessage => ({ agentId: "reviewer-1", sessionId: "session-1", writtenAt, text, locator: partialFake<SourceTextLocator>({}) });
const target = (text: string) => ({ repo: "octo/demo", pr: 7, head: HEAD, lineOffset: text.split("\n").indexOf("Verdict: MERGE") });

/** The text the final message's Attests line is read from, after `between` sits between the full review and it. */
function lendingText(finalText: string, between: string[] = []): string {
  const earlier = [REVIEW, ...between].map((text, index) => message(index + 1, text));
  return labelSource(message(earlier.length + 1, finalText), target(finalText), earlier).text;
}

describe("labelSource withdrawal anywhere after the full review", () => {
  it.each([
    ["a withdrawal after the block", `${BLOCK}\nI withdraw my attestation of ci-wait; its retry path changed.`],
    ["a note after the block", `Removed the review checkout.\n\n${BLOCK}\n\nRan the suite once more.`],
  ])("a final message carrying %s reads its own lines", (_shape, finalText) => {
    expect(lendingText(finalText)).toBe(finalText);
  });

  it("a withdrawal in a message with no block between the full review and the repeat ends the search", () => {
    const withdrawal = "On reflection ci-wait's closure does change behaviour; I withdraw the attestation above.";

    expect(lendingText(BARE_REPEAT, [withdrawal])).toBe(BARE_REPEAT);
  });

  it("a cleanup note with no block between the full review and the repeat is passed over", () => {
    expect(lendingText(BARE_REPEAT, ["Now I'll remove the review checkout directory."])).toBe(REVIEW);
  });
});
