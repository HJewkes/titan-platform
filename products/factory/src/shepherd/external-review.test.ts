import { fakeSha } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it, vi } from "vitest";
import type { AwaitVerdictResult, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import { DamagedTranscriptError, acceptExternalVerdict, SEAT_REVIEWER, newestAtHead, seatFixFirst, unlessSeatFixFirst } from "./external-review.js";

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

const SEAT = agent("seat-c-9-review");
const SHEPHERD_RV = agent("rv-octo-demo-4");
const rosterOf = (...rows: ReviewerAgent[]) => async () => rows;
const shepherdMerge: AwaitVerdictResult = { kind: "verdict", verdict: "MERGE", head: HEAD, locator: locatorIn(SHEPHERD_RV.sessionId), reviewer: { agentId: SHEPHERD_RV.agentId, sessionId: SHEPHERD_RV.sessionId } };

describe("SEAT_REVIEWER", () => {
  it.each(["seat-a-12-review", "seat-b-7-review-r2", "x-review-r10"])("matches the seat reviewer name %s", (name) => {
    expect(SEAT_REVIEWER.test(name)).toBe(true);
  });

  it.each(["rv-octo-demo-4", "rv-octo-demo-4-2", "seat-b-7-review-fix", "review-r", "impl-a"])("does not match %s", (name) => {
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

describe("acceptExternalVerdict", () => {
  it("accepts the MERGE of the reviewer at the head", () => {
    expect(acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, [said(SEAT, verdictAt("MERGE"), 2)])).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });

  it("is no verdict when a WAIT strictly follows a MERGE at the same head", () => {
    const messages = [said(SEAT, verdictAt("MERGE"), 2), said(SEAT, verdictAt("WAIT"), 3)];

    expect(acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, messages)).toEqual({ kind: "none", reason: "wait" });
  });

  it("is no verdict when a WAIT and a MERGE carry the same time", () => {
    const messages = [said(SEAT, verdictAt("MERGE"), 2), said(SEAT, verdictAt("WAIT"), 2)];

    expect(acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, messages).kind).toBe("none");
  });

  it("accepts a MERGE that follows a WAIT", () => {
    const messages = [said(SEAT, verdictAt("WAIT"), 2), said(SEAT, verdictAt("MERGE"), 3)];

    expect(acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, messages)).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });

  it("ignores a WAIT that names another head", () => {
    const messages = [said(SEAT, verdictAt("MERGE"), 2), said(SEAT, verdictAt("WAIT", OLD_HEAD), 3)];

    expect(acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, messages)).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });
});

describe("a seat reviewer's WAIT", () => {
  it("is the newest verdict at the head, never a MERGE", () => {
    expect(newestAtHead(target, [said(SEAT, verdictAt("WAIT"), 2)])?.verdict).toBe("WAIT");
  });

  it("beats a MERGE written at the same time", () => {
    expect(newestAtHead(target, [said(SEAT, verdictAt("MERGE"), 2), said(SEAT, verdictAt("WAIT"), 2)])?.verdict).toBe("WAIT");
  });

  it("never reads clear, and names the unfinished checks", async () => {
    const result = await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("WAIT"), 5)]), target);

    expect(result).toMatchObject({ kind: "none", reason: expect.stringContaining("WAIT") });
  });

  it("turns Shepherd's MERGE into a blocking none", async () => {
    const result = await unlessSeatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("WAIT"), 5)]), target, shepherdMerge);

    expect(result.kind).toBe("none");
  });

  it("clears once the same reviewer later answers MERGE at the same head", async () => {
    const result = await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("WAIT"), 5), said(SEAT, verdictAt("MERGE"), 6)]), target);

    expect(result).toEqual({ kind: "clear" });
  });
});

describe("seatFixFirst", () => {
  it("returns a seat reviewer's FIX_FIRST at the head with its findings and its identity", async () => {
    const result = await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST"), 5)]), target);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", head: HEAD, reviewer: { agentId: SEAT.agentId, sessionId: SEAT.sessionId } });
    expect((result as { text: string }).text).toContain("Seat reviewer seat-c-9-review said FIX_FIRST");
    expect((result as { text: string }).text).toContain("Findings.");
  });

  it("clears when the same reviewer later writes a MERGE at the same head, in a later session under the same name", async () => {
    const resumed = agent(SEAT.name, "session-later");
    const messages = [said(SEAT, verdictAt("FIX_FIRST"), 5), said(resumed, verdictAt("MERGE"), 9)];

    expect(await seatFixFirst(rosterOf(SEAT, resumed), readerOf(messages), target)).toEqual({ kind: "clear" });
  });

  it("does not block the head on a FIX_FIRST that named an older head", async () => {
    expect(await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST", OLD_HEAD), 5)]), target)).toEqual({ kind: "clear" });
  });

  it("does not let another reviewer's later MERGE clear a seat reviewer's FIX_FIRST", async () => {
    const other = agent("seat-c-9-review-r2");
    const messages = [said(SEAT, verdictAt("FIX_FIRST"), 5), said(other, verdictAt("MERGE"), 9)];

    expect(await seatFixFirst(rosterOf(SEAT, other), readerOf(messages), target)).toMatchObject({ verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
  });

  it("blocks on a FIX_FIRST whose block names the repo in another letter case", async () => {
    const shouted = said(SEAT, verdictAt("FIX_FIRST").replace(`PR: ${REPO}#4`, `PR: ${REPO.toUpperCase()}#4`), 5);

    expect(await seatFixFirst(rosterOf(SEAT), readerOf([shouted]), target)).toMatchObject({ verdict: "FIX_FIRST" });
  });

  it("ignores a FIX_FIRST from an agent whose name is not a seat reviewer's", async () => {
    const coord = agent("design-coord");

    expect(await seatFixFirst(rosterOf(coord), readerOf([said(coord, verdictAt("FIX_FIRST"), 5)]), target)).toEqual({ kind: "clear" });
  });

  it("drops a message the reader attributes to a session the roster does not list under the name", async () => {
    const stray = { ...said(SEAT, verdictAt("FIX_FIRST"), 5), sessionId: "session-elsewhere" };
    const reader: ReviewerReader = { read: async () => [stray] };

    expect(await seatFixFirst(rosterOf(SEAT), reader, target)).toEqual({ kind: "clear" });
  });

  it("blocks the head with the failure named when the roster cannot be read", async () => {
    const roster = async () => Promise.reject(new Error("broker down"));

    expect(await seatFixFirst(roster, readerOf([]), target)).toEqual({ kind: "none", reason: "seat check: the roster could not be read: broker down" });
  });

  it("blocks the head with the reviewer named when a seat reviewer's transcript cannot be read", async () => {
    const reader: ReviewerReader = { read: async () => Promise.reject(new Error("EACCES: permission denied")) };

    expect(await seatFixFirst(rosterOf(SEAT), reader, target)).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: EACCES: permission denied` });
  });

  it("prefers another seat reviewer's FIX_FIRST over a transcript that cannot be read", async () => {
    const broken = agent("seat-d-1-review");
    const reader: ReviewerReader = { read: async (input) => (input.reviewerAgentId === broken.agentId ? Promise.reject(new Error("bad json")) : [said(SEAT, verdictAt("FIX_FIRST"), 5)]) };

    expect(await seatFixFirst(rosterOf(broken, SEAT), reader, target)).toMatchObject({ verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
  });

  describe("a seat reviewer whose transcript ends in a partial record", () => {
    const damaged = agent("seat-f-3-review");
    const torn = (readable: readonly ReviewerMessage[], brief: string | null = null) => new DamagedTranscriptError("the exited session ends in a partial record", readable, brief);
    /** A reader whose damaged reviewer's complete records hold `readable` and `brief`; every other reviewer has said nothing. */
    const damagedReader = (readable: readonly ReviewerMessage[], brief: string | null = null): ReviewerReader => ({
      read: async (input) => (input.reviewerAgentId === damaged.agentId ? Promise.reject(torn(readable, brief)) : []),
    });
    const reviewing = (pr: number) => [said(damaged, `Findings.\n\nVerdict: MERGE\nPR: ${REPO}#${pr}\nHead: ${OLD_HEAD}\n`, 3)];

    it("leaves another PR's MERGE standing and warns when the damaged reviewer reviews a different PR", async () => {
      const warn = vi.fn();

      expect(await unlessSeatFixFirst(rosterOf(damaged, SEAT), damagedReader(reviewing(5)), target, shepherdMerge, warn)).toEqual(shepherdMerge);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${damaged.name} is not the reviewer of ${REPO}#4`));
    });

    it("blocks the PR whose own reviewer's transcript is damaged", async () => {
      const warn = vi.fn();

      expect(await unlessSeatFixFirst(rosterOf(damaged), damagedReader(reviewing(4)), target, shepherdMerge, warn)).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${damaged.name} could not be read: the exited session ends in a partial record`,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns without blocking when the damaged transcript names no PR, since it cannot be tied to this one", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(damaged), damagedReader([said(damaged, "Reading the diff.", 2)]), target, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledOnce();
    });

    it("still blocks on a later reviewer's failed read after an unrelated damaged transcript", async () => {
      const broken = agent("seat-g-4-review");
      const reader: ReviewerReader = {
        read: async (input) => (input.reviewerAgentId === broken.agentId ? Promise.reject(new Error("EACCES")) : damagedReader(reviewing(5)).read(input)),
      };

      expect(await seatFixFirst(rosterOf(damaged, broken), reader, target, vi.fn())).toMatchObject({ kind: "none", reason: expect.stringContaining(broken.name) });
    });

    it("blocks the PR its brief names when the reviewer was torn before any verdict, and leaves another PR's MERGE standing", async () => {
      const reader = damagedReader([said(damaged, "Reading the diff.", 2)], `Review ${REPO}#4 at ${HEAD}.`);

      expect(await unlessSeatFixFirst(rosterOf(damaged), reader, target, shepherdMerge, vi.fn())).toMatchObject({ kind: "none" });
      expect(await unlessSeatFixFirst(rosterOf(damaged), reader, { ...target, pr: 5 }, shepherdMerge, vi.fn())).toEqual(shepherdMerge);
    });

    it.each([`Review OCTO/Demo#4 now.`, `Review demo#4 now.`, `(octo/DEMO#4)`])("ties the reviewer to PR 4 by the brief %s", async (brief) => {
      expect(await seatFixFirst(rosterOf(damaged), damagedReader([], brief), target, vi.fn())).toMatchObject({ kind: "none" });
    });

    it.each([`Review octo/demo#40 now.`, `Review other/demo#4 now.`, `Review octo/demo-x#4 now.`])("does not tie the reviewer to PR 4 by the brief %s", async (brief) => {
      expect(await seatFixFirst(rosterOf(damaged), damagedReader([], brief), target, vi.fn())).toEqual({ kind: "clear" });
    });

    it("ties the reviewer to the PR by a verdict block that names the repo in another letter case", async () => {
      const shouted = [said(damaged, `Findings.\n\nVerdict: MERGE\nPR: OCTO/Demo#4\nHead: ${OLD_HEAD}\n`, 3)];

      expect(await seatFixFirst(rosterOf(damaged), damagedReader(shouted), target, vi.fn())).toMatchObject({ kind: "none" });
    });

    describe("under a name with two sessions", () => {
      const first = agent("seat-h-5-review", "session-1");
      const second = agent("seat-h-5-review", "session-2");
      /** Session 1 is whole and says `earlier`; session 2 is damaged, untied unless its complete records say otherwise. */
      const twoSessions = (earlier: readonly ReviewerMessage[]): ReviewerReader => ({
        read: async (input) => (input.reviewerSessionId === second.sessionId ? Promise.reject(torn([said(second, "Reading.", 9)])) : earlier),
      });

      it("keeps session 1's FIX_FIRST at the head when session 2 is damaged and untied", async () => {
        const reader = twoSessions([said(first, verdictAt("FIX_FIRST"), 5)]);

        expect(await unlessSeatFixFirst(rosterOf(first, second), reader, target, shepherdMerge, vi.fn())).toMatchObject({ verdict: "FIX_FIRST", reviewer: { sessionId: first.sessionId } });
      });

      it("blocks when session 1's verdict ties the name to the PR and session 2 is damaged", async () => {
        const reader = twoSessions([said(first, verdictAt("MERGE", OLD_HEAD), 5)]);

        expect(await seatFixFirst(rosterOf(first, second), reader, target, vi.fn())).toMatchObject({ kind: "none", reason: expect.stringContaining(first.name) });
      });

      it("warns without blocking when neither session ties the name to the PR", async () => {
        const warn = vi.fn();

        expect(await seatFixFirst(rosterOf(first, second), twoSessions([said(first, "Reading.", 5)]), target, warn)).toEqual({ kind: "clear" });
        expect(warn).toHaveBeenCalledOnce();
      });
    });
  });

  it("does not block on a running seat reviewer whose transcript has nothing to read yet", async () => {
    const running = { ...agent("seat-e-2-review"), presence: "live" as const };

    expect(await seatFixFirst(rosterOf(running), readerOf([]), target)).toEqual({ kind: "clear" });
  });
});

describe("unlessSeatFixFirst", () => {
  it("turns Shepherd's MERGE into the seat reviewer's FIX_FIRST at the same head", async () => {
    const result = await unlessSeatFixFirst(rosterOf(SHEPHERD_RV, SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST"), 5)]), target, shepherdMerge);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
  });

  it("turns Shepherd's MERGE into a blocking none when the roster cannot be read", async () => {
    const roster = async () => Promise.reject(new Error("broker down"));

    expect(await unlessSeatFixFirst(roster, readerOf([]), target, shepherdMerge)).toMatchObject({ kind: "none", reason: expect.stringContaining("roster could not be read") });
  });

  it("keeps a FIX_FIRST or a none as it is without reading the roster", async () => {
    const roster = vi.fn(rosterOf(SEAT));
    const fixFirst: AwaitVerdictResult = { ...shepherdMerge, verdict: "FIX_FIRST", text: "own findings" };

    expect(await unlessSeatFixFirst(roster, readerOf([]), target, fixFirst)).toBe(fixFirst);
    expect(await unlessSeatFixFirst(roster, readerOf([]), target, { kind: "none" })).toEqual({ kind: "none" });
    expect(roster).not.toHaveBeenCalled();
  });
});
