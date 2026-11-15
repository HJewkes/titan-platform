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

/** Synthetic replies with the line shapes of the four adversary MERGE replies that a prose Authority lead refused. */
const PROSE_LED_REPLIES: readonly (readonly [string, string])[] = [
  ["a bold paragraph lead", `Reviewed the diff.\n\n**Authority gate.** No console tap reaches the write path; the only caller is the guarded route.\n\n${probes}\nAuthority: unchanged\n\n${merge}`],
  ["the same paragraph after a correction", `Whole review again.\n\n**Authority gate.** No console tap: the write path has one caller, behind the guard.\n\n${probes}\nAuthority: unchanged\n\n${merge}`],
  ["a bold bullet lead", `Findings:\n\n- **Authority check first.** applyOp calls the guard before it writes anything.\n- **Empty input.** Refused.\n\n${probes}\nAuthority: unchanged\n\n${merge}`],
  ["the same bullet after a correction", `Findings:\n\n- **Authority check first.** applyOp calls the guard before any write, so an unknown op never lands.\n\n${probes}\nAuthority: unchanged\n\n${merge}`],
];

describe("acceptVerdict on an adversary MERGE with prose that starts with the word Authority", () => {
  it.each(PROSE_LED_REPLIES)("accepts %s as a MERGE reading unchanged", (_shape, reply) => {
    expect(acceptVerdict(adversary, [said(reply)])).toMatchObject({ kind: "verdict", verdict: "MERGE", authority: "unchanged" });
  });

  it("a widened line hidden mid-reply still reads widened", () => {
    const reply = `**Authority gate.** No console tap.\n\nAuthority: widened\nMore notes.\n\n${probes}\nAuthority: unchanged\n\n${merge}`;

    expect(acceptVerdict(adversary, [said(reply)])).toMatchObject({ verdict: "MERGE", authority: "widened" });
  });

  it("a dash-separated widened line still reads widened", () => {
    expect(acceptVerdict(adversary, [said(`${probes}\nAuthority - widened\nAuthority: unchanged\n\n${merge}`)])).toMatchObject({ verdict: "MERGE", authority: "widened" });
  });

  it("prose leads with no Authority line are refused as authority_missing with nothing to quote", () => {
    const reply = `**Authority gate.** No console tap.\n\n${probes}\n\n${merge}`;

    expect(readMalformed(acceptVerdict(adversary, [said(reply)]))).toEqual({ refusal: "authority_missing", writtenAt: WRITTEN_AT });
  });

  it("an authority_missing refusal quotes the line that read malformed", () => {
    const reply = `${probes}\n**Authority:** unchanged, I think\n\n${merge}`;

    expect(readMalformed(acceptVerdict(adversary, [said(reply)]))).toEqual({ refusal: "authority_missing", writtenAt: WRITTEN_AT, quotes: ["**Authority:** unchanged, I think"] });
  });

  it.each([
    "**Authority widened:** the lander can now merge without review",
    "**Authority widened.** The new route skips the guard.",
    "Authority widened by letting the bot merge.",
    "Authority is widened: bot merges",
    "Authority widened — see above",
    "**Authority widens:** the bot can now merge",
    "**Authority widening.** The bot can now merge without review.",
    "Authority gate: widens",
  ])("a widening stated in prose, %s, beside an unchanged line is never a MERGE reading unchanged", (prose) => {
    const result = acceptVerdict(adversary, [said(`${prose}\n\n${probes}\nAuthority: unchanged\n\n${merge}`)]);

    expect(result).not.toMatchObject({ kind: "verdict", verdict: "MERGE", authority: "unchanged" });
  });
});
