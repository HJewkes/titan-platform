import { fakeSha } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it, vi } from "vitest";
import type { AwaitVerdictResult, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import { SEAT_REVIEWER, newestAtHead, seatFixFirst, unlessSeatFixFirst } from "./seat-verdict.js";

const REPO = "octo/demo";
const HEAD = fakeSha("seat-verdict-head");
const OLD_HEAD = fakeSha("seat-verdict-old-head");
const target = { repo: REPO, pr: 4, head: HEAD };

const agent = (name: string, session = `session-${name}`): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: session, presence: "exited", spawnedBy: "coord" });
const locatorIn = (nativeId: string) => ({ source: { conversation: { nativeId } } }) as unknown as SourceTextLocator;
const verdictAt = (verdict: string, head = HEAD) => `Findings.\n\nVerdict: ${verdict}\nPR: ${REPO}#4\nHead: ${head}\n`;
const said = (who: ReviewerAgent, text: string, writtenAt: number): ReviewerMessage => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt, text, locator: locatorIn(who.sessionId) });

/** A reader that returns the messages written by the agent and session it is asked about. */
const readerOf = (messages: readonly ReviewerMessage[]): ReviewerReader => ({
  read: async (input) => messages.filter((message) => message.agentId === input.reviewerAgentId && message.sessionId === input.reviewerSessionId),
});

const SEAT = agent("dc-td-9-review");
const SHEPHERD_RV = agent("rv-octo-demo-4");
const rosterOf = (...rows: ReviewerAgent[]) => async () => rows;
const shepherdMerge: AwaitVerdictResult = { kind: "verdict", verdict: "MERGE", head: HEAD, locator: locatorIn(SHEPHERD_RV.sessionId), reviewer: { agentId: SHEPHERD_RV.agentId, sessionId: SHEPHERD_RV.sessionId } };

describe("SEAT_REVIEWER", () => {
  it.each(["dc-td-104-review", "tc-tp-7-review-r2", "x-review-r10"])("matches the seat reviewer name %s", (name) => {
    expect(SEAT_REVIEWER.test(name)).toBe(true);
  });

  it.each(["rv-octo-demo-4", "rv-octo-demo-4-2", "tc-tp-7-review-fix", "review-r", "impl-a"])("does not match %s", (name) => {
    expect(SEAT_REVIEWER.test(name)).toBe(false);
  });
});

describe("newestAtHead", () => {
  it("lets the later of two verdicts at the head decide, whichever order they are listed in", () => {
    const messages = [said(SEAT, verdictAt("MERGE"), 3), said(SEAT, verdictAt("FIX_FIRST"), 2)];

    expect(newestAtHead(target, messages)?.verdict).toBe("MERGE");
  });

  it("takes the FIX_FIRST when two verdicts at the head carry the same time", () => {
    const messages = [said(SEAT, verdictAt("MERGE"), 2), said(SEAT, verdictAt("FIX_FIRST"), 2), said(SEAT, verdictAt("MERGE"), 2)];

    expect(newestAtHead(target, messages)?.verdict).toBe("FIX_FIRST");
  });

  it("skips a message with no readable time", () => {
    expect(newestAtHead(target, [said(SEAT, verdictAt("FIX_FIRST"), Number.NaN)])).toBeUndefined();
  });
});

describe("seatFixFirst", () => {
  it("returns a seat reviewer's FIX_FIRST at the head with its findings and its identity", async () => {
    const result = await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST"), 5)]), target);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", head: HEAD, reviewer: { agentId: SEAT.agentId, sessionId: SEAT.sessionId } });
    expect((result as { text: string }).text).toContain("Seat reviewer dc-td-9-review said FIX_FIRST");
    expect((result as { text: string }).text).toContain("Findings.");
  });

  it("clears when the same reviewer later writes a MERGE at the same head, in a later session under the same name", async () => {
    const resumed = agent(SEAT.name, "session-later");
    const messages = [said(SEAT, verdictAt("FIX_FIRST"), 5), said(resumed, verdictAt("MERGE"), 9)];

    expect(await seatFixFirst(rosterOf(SEAT, resumed), readerOf(messages), target)).toEqual({ kind: "none" });
  });

  it("does not block the head on a FIX_FIRST that named an older head", async () => {
    expect(await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST", OLD_HEAD), 5)]), target)).toEqual({ kind: "none" });
  });

  it("does not let another reviewer's later MERGE clear a seat reviewer's FIX_FIRST", async () => {
    const other = agent("dc-td-9-review-r2");
    const messages = [said(SEAT, verdictAt("FIX_FIRST"), 5), said(other, verdictAt("MERGE"), 9)];

    expect(await seatFixFirst(rosterOf(SEAT, other), readerOf(messages), target)).toMatchObject({ verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
  });

  it("ignores a FIX_FIRST from an agent whose name is not a seat reviewer's", async () => {
    const coord = agent("design-coord");

    expect(await seatFixFirst(rosterOf(coord), readerOf([said(coord, verdictAt("FIX_FIRST"), 5)]), target)).toEqual({ kind: "none" });
  });

  it("drops a message the reader attributes to a session the roster does not list under the name", async () => {
    const stray = { ...said(SEAT, verdictAt("FIX_FIRST"), 5), sessionId: "session-elsewhere" };
    const reader: ReviewerReader = { read: async () => [stray] };

    expect(await seatFixFirst(rosterOf(SEAT), reader, target)).toEqual({ kind: "none" });
  });

  it("reads an unreadable roster as no seat verdict", async () => {
    const roster = async () => Promise.reject(new Error("broker down"));

    expect(await seatFixFirst(roster, readerOf([]), target)).toEqual({ kind: "none" });
  });
});

describe("unlessSeatFixFirst", () => {
  it("turns Shepherd's MERGE into the seat reviewer's FIX_FIRST at the same head", async () => {
    const result = await unlessSeatFixFirst(rosterOf(SHEPHERD_RV, SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST"), 5)]), target, shepherdMerge);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
  });

  it("keeps a FIX_FIRST or a none as it is without reading the roster", async () => {
    const roster = vi.fn(rosterOf(SEAT));
    const fixFirst: AwaitVerdictResult = { ...shepherdMerge, verdict: "FIX_FIRST", text: "own findings" };

    expect(await unlessSeatFixFirst(roster, readerOf([]), target, fixFirst)).toBe(fixFirst);
    expect(await unlessSeatFixFirst(roster, readerOf([]), target, { kind: "none" })).toEqual({ kind: "none" });
    expect(roster).not.toHaveBeenCalled();
  });
});
