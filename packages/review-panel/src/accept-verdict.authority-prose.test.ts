import { partialFake } from "@titan-design/test-kit";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { acceptVerdict } from "./accept-verdict.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";
import { readMalformed } from "./verdict-schemas.js";

const HEAD = "e".repeat(40);
const DISPATCHED_AT = 2_000_000;
const WRITTEN_AT = DISPATCHED_AT + 5_000;
const adversary: AwaitVerdictInput = { repo: "octo/demo", pr: 9, head: HEAD, reviewerAgentId: "adversary-1", reviewerSessionId: "session-9", dispatchedAt: DISPATCHED_AT, shape: "adversary" };
const locator = partialFake<SourceTextLocator>({
  source: partialFake<SourceTextLocator["source"]>({ conversation: partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: "session-9" }) }),
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});
const said = (text: string): ReviewerMessage => ({ agentId: "adversary-1", sessionId: "session-9", writtenAt: WRITTEN_AT, text, locator, investigativeCalls: 4 });
const merge = `Verdict: MERGE\nPR: octo/demo#9\nHead: ${HEAD}\n`;
const probes = "Probes: unknown op -> refused; empty payload -> refused; second entry point -> routes through the guard";
const reply = (body: string): string => `${body}\n\n${probes}\nAuthority: unchanged\n\n${merge}`;

/** Synthetic replies with the line shapes of the adversary MERGE replies a prose Authority lead refused, each with its reworded correction. */
const REPLIES: readonly (readonly [string, string, string])[] = [
  ["a bold paragraph lead", "**Authority gate.** No console tap reaches the write path; the only caller is the guarded route.", "**Write gate.** No console tap reaches the write path; the only caller is the guarded route."],
  ["a bold bullet lead", "- **Authority check first.** applyOp calls the guard before it writes anything.", "- **Guard check first.** applyOp calls the guard before it writes anything."],
];

describe("acceptVerdict on an adversary MERGE with prose that starts with the word Authority", () => {
  it.each(REPLIES)("a reply with %s is refused authority_missing quoting that lead", (_shape, lead) => {
    const result = acceptVerdict(adversary, [said(reply(`Reviewed the diff.\n\n${lead}\n- **Empty input.** Refused.`))]);

    expect(readMalformed(result)).toEqual({ refusal: "authority_missing", writtenAt: WRITTEN_AT, quotes: [lead] });
  });

  it.each(REPLIES)("the corrected reply with %s reworded is accepted as MERGE, authority unchanged", (_shape, _lead, reworded) => {
    const result = acceptVerdict(adversary, [said(reply(`Reviewed the diff.\n\n${reworded}\n- **Empty input.** Refused.`))]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE", authority: "unchanged" });
  });

  it("a reply with no Authority line is refused with no quote", () => {
    const result = acceptVerdict(adversary, [said(`The guard holds.\n\n${probes}\n\n${merge}`)]);

    expect(readMalformed(result)).toEqual({ refusal: "authority_missing", writtenAt: WRITTEN_AT });
  });
});
