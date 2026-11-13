import { partialFake } from "@titan-design/test-kit";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { acceptVerdict } from "./accept-verdict.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";

const HEAD = "c".repeat(40);
const DISPATCHED_AT = 1_000_000;
const input: AwaitVerdictInput = { repo: "octo/demo", pr: 7, head: HEAD, reviewerAgentId: "reviewer-1", reviewerSessionId: "session-1", dispatchedAt: DISPATCHED_AT };
const sessionLocator = (nativeId: string) =>
  partialFake<SourceTextLocator>({
    source: partialFake<SourceTextLocator["source"]>({ conversation: partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId }) }),
    selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
  });
const locator = sessionLocator("session-1");
const verdictMessage = (writtenAt: number): ReviewerMessage => ({ agentId: "reviewer-1", sessionId: "session-1", writtenAt, text: "", locator });

describe("acceptVerdict repeated verdict block", () => {
  const CI_WAIT = `ci-wait@${"a".repeat(12)}`;
  const block = (verdict = "MERGE", head = HEAD) => `Verdict: ${verdict}\nPR: octo/demo#7\nHead: ${head}\n`;
  const review = `Read the diff and ran the suite. ${"Every branch is covered. ".repeat(20)}`;
  const at = (offset: number, text: string, overrides: Partial<ReviewerMessage> = {}): ReviewerMessage => ({ ...verdictMessage(DISPATCHED_AT + offset), text, ...overrides });
  const fullVerdict = (offset: number, extra = `Attests: ${CI_WAIT}\n`) => at(offset, `${review}\n${extra}\n${block()}CI-policy: unchanged`);
  const bareRepeat = (offset: number) => at(offset, `I've removed the review checkout directory.\n\n${block()}CI-policy: unchanged`);

  it("a MERGE whose final message repeats a bare verdict block keeps the Attests line of the full verdict above it", () => {
    const followUp = "Follow-ups:\n- Name the cap | the cap has a name | low\n";

    const result = acceptVerdict(input, [fullVerdict(1, `${followUp}\nAttests: ${CI_WAIT}\n`), bareRepeat(2)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE", attests: [CI_WAIT], followUps: [{ title: "Name the cap" }] });
  });

  it("a bare repeat after a full verdict with no Attests line attests nothing", () => {
    const result = acceptVerdict(input, [fullVerdict(1, "A real behaviour change on those inputs, so I can't attest.\n"), bareRepeat(2)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(result).not.toHaveProperty("attests");
  });

  it("a full final verdict without Attests does not borrow an earlier draft's line", () => {
    const result = acceptVerdict(input, [fullVerdict(1), fullVerdict(2, "On a second look I withdraw the attestation.\n")]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(result).not.toHaveProperty("attests");
  });

  it.each([
    ["another head", block("MERGE", "d".repeat(40))],
    ["a FIX_FIRST", block("FIX_FIRST")],
  ])("an earlier message at %s lends nothing", (_shape, otherBlock) => {
    const superseding = at(2, `${review}\n\n${otherBlock}`);

    const result = acceptVerdict(input, [fullVerdict(1), superseding, bareRepeat(3)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(result).not.toHaveProperty("attests");
  });

  it("a message from another session lends nothing", () => {
    const foreignLocator = sessionLocator("session-2");
    const ownSessionIdForeignLocator = { ...fullVerdict(1), locator: foreignLocator };

    const foreign = acceptVerdict(input, [{ ...fullVerdict(1), sessionId: "session-2", locator: foreignLocator }, bareRepeat(2)]);
    const relabelled = acceptVerdict(input, [ownSessionIdForeignLocator, bareRepeat(2)]);
    const beforeDispatch = acceptVerdict(input, [fullVerdict(-1), bareRepeat(2)]);

    for (const result of [foreign, relabelled, beforeDispatch]) {
      expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
      expect(result).not.toHaveProperty("attests");
    }
  });

  it("a CI-policy weakening is read from the final message only", () => {
    const weakenedEarlier = at(1, `${review}\nAttests: ${CI_WAIT}\n\n${block()}CI-policy: weakened permissions`);

    const result = acceptVerdict(input, [weakenedEarlier, bareRepeat(2)]);
    const weakenedFinal = acceptVerdict(input, [fullVerdict(1), at(2, `Done.\n\n${block()}CI-policy: weakened permissions`)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE", ciPolicy: { kind: "unchanged" }, attests: [CI_WAIT] });
    expect(weakenedFinal).toMatchObject({ kind: "verdict", verdict: "MERGE", ciPolicy: { kind: "weakened", keys: ["permissions"] }, attests: [CI_WAIT] });
  });
});
