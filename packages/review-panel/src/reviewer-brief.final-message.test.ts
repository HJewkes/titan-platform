import { partialFake } from "@titan-design/test-kit";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { acceptVerdict } from "./accept-verdict.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";
import { reviewerBrief } from "./reviewer-brief.js";

// Labels are read from the final message only; these pin that the brief asks for everything there and that a bare repeat
// after a full verdict stays fail-closed (TP-5689).
const HEAD = "c".repeat(40);
const DISPATCHED_AT = 1_000_000;
const target = { repo: "octo/demo" as const, pr: 7, head: HEAD, checkoutRoot: "/data/titan-factory/checkouts/reviews" };
const input: AwaitVerdictInput = { repo: "octo/demo", pr: 7, head: HEAD, reviewerAgentId: "reviewer-1", reviewerSessionId: "session-1", dispatchedAt: DISPATCHED_AT };
const CI_WAIT = `ci-wait@${"a".repeat(12)}`;
const MERGE_STEP = `merge@${"b".repeat(12)}`;
const FOLLOW_UPS = "Follow-ups:\n- Name the retry bound | The bound is a named constant | low";
const BLOCK = `Verdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`;
const locator = partialFake<SourceTextLocator>({
  source: partialFake<SourceTextLocator["source"]>({ conversation: partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: "session-1" }) }),
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});
const said = (text: string, writtenAt: number): ReviewerMessage => ({ agentId: "reviewer-1", sessionId: "session-1", writtenAt, text, locator });

describe("reviewer brief final message", () => {
  it.each([
    ["a review in a scratch dir", reviewerBrief(target)],
    ["a review that starts in its run dir", reviewerBrief({ ...target, sourceCheckout: "/srv/checkouts/demo" })],
  ])("the brief asks for cleanup before the final message and for the full verdict in it, in %s", (_shape, brief) => {
    const cleanup = brief.indexOf("rm -rf");
    const sentence = brief.slice(brief.lastIndexOf("\n", cleanup), brief.indexOf("\n", cleanup));

    expect(sentence).toContain("before you write your final message, remove your checkouts");
    expect(sentence).toContain("Your final message is your whole review and verdict, including any `Attests:` and `Follow-ups:` lines; send no message after it.");
    expect(brief).not.toContain("After you write your verdict, remove");
  });

  it("the attest rule says only the final message's Attests line counts", () => {
    const brief = reviewerBrief({ ...target, attestClaims: [{ step: "ci-wait", closure: "0123456789ab" }] });

    expect(brief).toContain("`Attests: ci-wait@0123456789ab`, keeping only the steps you verified. Omit it otherwise; your MERGE still counts for the code.\nAn `Attests:` line counts only in your final message.");
    expect(reviewerBrief(target)).not.toContain("counts only in your final message");
  });

  it("a bare repeat after a full verdict with Attests attests nothing", () => {
    const full = said(`Checked the retry path.\n\n${FOLLOW_UPS}\n\nAttests: ${CI_WAIT}\n\n${BLOCK}`, DISPATCHED_AT + 1);
    const repeat = said(BLOCK, DISPATCHED_AT + 2);

    const result = acceptVerdict(input, [full, repeat]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(result).not.toHaveProperty("attests");
    expect(result).not.toHaveProperty("followUps");
  });

  it("a final message carrying the full verdict and Attests is read", () => {
    const draft = said(`Still reading.\n\n${BLOCK}`, DISPATCHED_AT + 1);
    const final = said(`Checked the retry path.\n\n${FOLLOW_UPS}\n\nAttests: ${CI_WAIT}, ${MERGE_STEP}\n\n${BLOCK}`, DISPATCHED_AT + 2);

    const result = acceptVerdict(input, [draft, final]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE", attests: [CI_WAIT, MERGE_STEP], followUps: [{ title: "Name the retry bound" }] });
  });
});
