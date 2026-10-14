import { fakeSha } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seatTranscript, type SeatRow } from "../test-support/seat-transcript.js";
import type { AwaitVerdictResult, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import { FINDINGS_SEPARATOR } from "@titan-design/review-panel";
import { BrokerUnavailableError, DispatchError, DispatchTimeoutError } from "@titan-design/agent-dispatch";
import { ReviewerAskTimedOut, ReviewerBrokerBusy, ReviewerBrokerDown, reviewWait } from "./review-wait.js";
import { transcriptReviewerReader } from "./reviewer-reader.js";
import { DamagedTranscriptError, acceptExternalVerdict, awaitExternalVerdict, SEAT_REVIEWER, newestAtHead, seatFixFirst, seatVetoed, unlessSeatFixFirst } from "./external-review.js";

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
/** An earlier session of SEAT that reviewed PR 4, so a failed read of SEAT's own session is this PR's reviewer's. */
const SEAT_EARLIER = agent(SEAT.name, "session-earlier");
/** SEAT's session fails with `error`; its earlier session's MERGE at an older head ties the name to PR 4. */
const tiedFailing = (error: unknown): ReviewerReader => ({
  read: async (input) => (input.reviewerSessionId === SEAT.sessionId ? Promise.reject(error) : [said(SEAT_EARLIER, verdictAt("MERGE", OLD_HEAD), 3)]),
});
const tiedRoster = rosterOf(SEAT_EARLIER, SEAT);
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

  it("keeps the CI-policy line of an external MERGE, and has none when the reviewer wrote none", () => {
    const external = { ...target, external: SEAT.name };

    const weakened = acceptExternalVerdict(external, SEAT, [said(SEAT, `${verdictAt("MERGE")}CI-policy: weakened permissions, secrets\n`, 2)]);
    const plain = acceptExternalVerdict(external, SEAT, [said(SEAT, verdictAt("MERGE"), 2)]);

    expect(weakened).toMatchObject({ verdict: "MERGE", ciPolicy: { kind: "weakened", keys: ["permissions", "secrets"] } });
    expect(plain).not.toHaveProperty("ciPolicy");
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

    expect(result).toMatchObject({ kind: "clear" });
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

    expect(await seatFixFirst(rosterOf(SEAT, resumed), readerOf(messages), target)).toMatchObject({ kind: "clear" });
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

    expect(await seatFixFirst(roster, readerOf([]), target)).toEqual({ kind: "none", reason: "seat check: the roster could not be read: Error" });
  });

  it.each([
    ["a reviewer ask that timed out", new ReviewerAskTimedOut("agent-chat timed out")],
    ["a broker that is down", new ReviewerBrokerDown("connect refused")],
    ["a busy broker", new ReviewerBrokerBusy("machine guard")],
    ["a broker call that timed out", new DispatchTimeoutError("timed out")],
    ["an unreachable broker", new BrokerUnavailableError("unreachable")],
    ["an HTTP 502", Object.assign(new Error("bad gateway"), { status: 502 })],
  ])("marks a roster read failed by %s as one that may clear", async (_name, error) => {
    const roster = async () => Promise.reject(error);

    expect(await seatFixFirst(roster, readerOf([]), target)).toMatchObject({ kind: "none", retry: true });
  });

  it.each([
    ["a permission error", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })],
    ["a missing file", Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })],
    ["a JSON parse error", new SyntaxError("Unexpected end of JSON input")],
    ["an HTTP 403", Object.assign(new Error("forbidden"), { status: 403 })],
  ])("never marks a roster or transcript read failed by %s as one that may clear", async (_name, error) => {
    const roster = async () => Promise.reject(error);

    const unreadRoster = await seatFixFirst(roster, readerOf([]), target);
    const unreadTranscript = await seatFixFirst(tiedRoster, tiedFailing(error), target);

    expect(unreadRoster).toMatchObject({ kind: "none" });
    expect(unreadRoster).not.toHaveProperty("retry");
    expect(unreadTranscript).toMatchObject({ kind: "none" });
    expect(unreadTranscript).not.toHaveProperty("retry");
  });

  it("marks a transcript read that timed out as one that may clear", async () => {
    expect(await seatFixFirst(tiedRoster, tiedFailing(new ReviewerAskTimedOut("agent-chat timed out")), target)).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: ReviewerAskTimedOut`, retry: true });
  });

  it("blocks the head with the reviewer named when its own seat reviewer's transcript cannot be read", async () => {
    expect(await seatFixFirst(tiedRoster, tiedFailing(new Error("EACCES: permission denied")), target)).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: Error` });
  });

  it("keeps neither a URL nor a token from a failed roster or transcript read in the reason", async () => {
    const leaky = new Error("https://db.example.invalid/x tok_FAKE0000SECRET");
    const roster = async () => Promise.reject(Object.assign(leaky, { status: 503 }));

    const unreadRoster = await seatFixFirst(roster, readerOf([]), target);
    const unreadTranscript = await seatFixFirst(tiedRoster, tiedFailing(new Error(leaky.message)), target);

    expect(unreadRoster).toEqual({ kind: "none", reason: "seat check: the roster could not be read: HTTP 503", retry: true });
    expect(unreadTranscript).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: Error` });
    for (const text of [JSON.stringify(unreadRoster), JSON.stringify(unreadTranscript)]) {
      expect(text).not.toContain("db.example.invalid");
      expect(text).not.toContain("tok_FAKE0000SECRET");
    }
  });

  describe("a seat reviewer whose read fails with agent-chat's DispatchError", () => {
    const slow = new DispatchError("agent-chat refused agent ls: broker did not answer agents_result");
    const unrelated = agent("seat-k-8-review");
    const unrelatedFailing: ReviewerReader = { read: async (input) => (input.reviewerAgentId === unrelated.agentId ? Promise.reject(slow) : []) };

    /** A seat wait on a fake clock, so the deadline bounds how long a read that may clear holds the MERGE. */
    const seatWait = () => {
      let clock = 0;
      return { timing: { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: SEAT_POLL_MS, timeoutMs: SEAT_BOUND_MS }, signal: new AbortController().signal };
    };

    it("leaves Shepherd's MERGE standing and warns with the error's text when an untied reviewer's refusal reads the same every time", async () => {
      const refused = new DispatchError("agent-chat agent ls --json printed invalid JSON");
      const reader: ReviewerReader = { read: async (input) => (input.reviewerAgentId === unrelated.agentId ? Promise.reject(refused) : []) };
      const warn = vi.fn();

      expect(await unlessSeatFixFirst(rosterOf(unrelated, SEAT), reader, target, shepherdMerge, warn)).toEqual(shepherdMerge);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${unrelated.name} is not the reviewer of ${REPO}#4`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("printed invalid JSON"));
    });

    it("blocks with a retry when an untied reviewer's read fails in a way that may clear, since it may be this PR's own", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(unrelated, SEAT), unrelatedFailing, target, warn)).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${unrelated.name} could not be read: DispatchError: agent-chat refused agent ls: broker did not answer agents_result`,
        retry: true,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("blocks with a retry when the PR's own sole-session reviewer's read fails in a way that may clear", async () => {
      const own = agent("x-review");
      const reader: ReviewerReader = { read: async () => Promise.reject(slow) };

      expect(await unlessSeatFixFirst(rosterOf(own), reader, target, shepherdMerge, vi.fn())).toMatchObject({ kind: "none", reason: expect.stringContaining(own.name) });
      expect(await seatFixFirst(rosterOf(own), reader, target, vi.fn())).toMatchObject({ kind: "none", retry: true });
    });

    it("lets Shepherd's MERGE stand once an untied reviewer's failed read clears within the seat wait", async () => {
      let reads = 0;
      const reader: ReviewerReader = { read: async (input) => (input.reviewerAgentId === unrelated.agentId && ++reads === 1 ? Promise.reject(slow) : []) };

      expect(await unlessSeatFixFirst(rosterOf(unrelated, SEAT), reader, target, shepherdMerge, vi.fn(), Date.now, seatWait())).toBe(shepherdMerge);
      expect(reads).toBe(2);
    });

    it("holds Shepherd's MERGE for the next round when an untied reviewer's read still fails at the seat wait's deadline", async () => {
      const result = await unlessSeatFixFirst(rosterOf(unrelated, SEAT), unrelatedFailing, target, shepherdMerge, vi.fn(), Date.now, seatWait());

      expect(result).toEqual({ kind: "none", reason: expect.stringContaining("broker did not answer agents_result"), seatHeld: shepherdMerge });
    });

    it("blocks the PR its own reviewer is tied to, naming the error's text, as a read that may clear", async () => {
      expect(await seatFixFirst(tiedRoster, tiedFailing(slow), target, vi.fn())).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${SEAT.name} could not be read: DispatchError: agent-chat refused agent ls: broker did not answer agents_result`,
        retry: true,
      });
    });

    it("blocks its own PR without a retry when the refusal will read the same again", async () => {
      const refused = new DispatchError("agent-chat agent ls --json printed invalid JSON");

      expect(await seatFixFirst(tiedRoster, tiedFailing(refused), target, vi.fn())).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: DispatchError: agent-chat agent ls --json printed invalid JSON` });
    });

    it("keeps no home path, URL or token from the error's text in the reason", async () => {
      const leaky = new DispatchError(`profile at ${os.homedir()}/.agent-chat/x.json via https://db.example.invalid/x ghp_FAKE0000SECRET`);

      const check = await seatFixFirst(async () => Promise.reject(leaky), readerOf([]), target);

      expect(check).toEqual({ kind: "none", reason: "seat check: the roster could not be read: DispatchError: profile at ~/.agent-chat/x.json via [url] [redacted]" });
    });
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
        reason: `seat check: the transcript of ${damaged.name} could not be read: DamagedTranscriptError`,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns without blocking when the damaged transcript names no PR, since it cannot be tied to this one", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(damaged), damagedReader([said(damaged, "Reading the diff.", 2)]), target, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledOnce();
    });

    it("still blocks on its own reviewer's failed read after an unrelated damaged transcript", async () => {
      const reader: ReviewerReader = {
        read: async (input) => (input.reviewerAgentId === SEAT.agentId ? tiedFailing(new Error("EACCES")).read(input) : damagedReader(reviewing(5)).read(input)),
      };

      expect(await seatFixFirst(rosterOf(damaged, SEAT_EARLIER, SEAT), reader, target, vi.fn())).toMatchObject({ kind: "none", reason: expect.stringContaining(SEAT.name) });
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

const SEAT_POLL_MS = 1_000;
const SEAT_BOUND_MS = 30 * SEAT_POLL_MS;

/** A clock that each sleep advances, and a reader whose seat says the next verdict in `answers` on every read. */
function seatSaying(...answers: string[]) {
  let clock = 0;
  let reads = 0;
  const reader: ReviewerReader = {
    read: async (input) => {
      const answer = answers[Math.min(reads, answers.length - 1)]!;
      reads += 1;
      return input.reviewerAgentId === SEAT.agentId ? [said(SEAT, verdictAt(answer), 5 + reads)] : [];
    },
  };
  const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: SEAT_POLL_MS, timeoutMs: SEAT_BOUND_MS };
  return { reader, seatWait: { timing, signal: new AbortController().signal }, reads: () => reads };
}

describe("Shepherd's MERGE meeting a seat WAIT", () => {
  it("names the seat that said WAIT on the check", async () => {
    const seat = seatSaying("WAIT");

    const check = await seatFixFirst(rosterOf(SEAT), seat.reader, target);

    expect(check).toMatchObject({ kind: "none", wait: true, seat: SEAT.name });
  });

  it("waits for the seat's MERGE and lets the own MERGE stand", async () => {
    const seat = seatSaying("WAIT", "WAIT", "MERGE");

    const result = await unlessSeatFixFirst(rosterOf(SEAT), seat.reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toBe(shepherdMerge);
    expect(seat.reads()).toBe(3);
  });

  it("is a G10 disagreement when the seat answers FIX_FIRST after its WAIT", async () => {
    const seat = seatSaying("WAIT", "FIX_FIRST");

    const result = await unlessSeatFixFirst(rosterOf(SEAT), seat.reader, target, shepherdMerge, undefined, () => 91, seat.seatWait);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId }, ownerOverride: { trigger: "g10-disagree", head: HEAD, shepherd: "MERGE", other: "FIX_FIRST", at: 91 } });
  });

  it("holds the own MERGE as seatHeld when the WAIT outlasts the bound", async () => {
    const seat = seatSaying("WAIT");

    const result = await unlessSeatFixFirst(rosterOf(SEAT), seat.reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("said WAIT"), seat: SEAT.name, seatHeld: shepherdMerge });
    expect(seat.reads()).toBe(SEAT_BOUND_MS / SEAT_POLL_MS + 1);
  });

  it("vetoes at once with no seat-wait timing, as before", async () => {
    const seat = seatSaying("WAIT", "MERGE");

    const result = await unlessSeatFixFirst(rosterOf(SEAT), seat.reader, target, shepherdMerge);

    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("said WAIT"), seat: SEAT.name });
    expect(seat.reads()).toBe(1);
  });

  it("holds the own MERGE with the failed read's reason when a read keeps failing through the wait", async () => {
    const seat = seatSaying("WAIT");
    let rosterReads = 0;
    const roster = async () => (++rosterReads > 1 ? Promise.reject(new ReviewerBrokerDown("broker down")) : [SEAT]);

    const result = await unlessSeatFixFirst(roster, seat.reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("roster could not be read"), seatHeld: shepherdMerge });
  });

  it("blocks at once, holding nothing, when a read during the wait fails in a way no re-read can mend", async () => {
    const seat = seatSaying("WAIT");
    let rosterReads = 0;
    const roster = async () => (++rosterReads > 1 ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) : [SEAT]);

    const result = await unlessSeatFixFirst(roster, seat.reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("roster could not be read") });
    expect(rosterReads).toBe(2);
  });

  it("lets the own MERGE stand when a roster read times out once and the seat then says MERGE", async () => {
    const seat = seatSaying("MERGE");
    let rosterReads = 0;
    const roster = async () => (++rosterReads === 1 ? Promise.reject(new ReviewerAskTimedOut("agent-chat timed out")) : [SEAT]);

    const result = await unlessSeatFixFirst(roster, seat.reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toBe(shepherdMerge);
    expect(rosterReads).toBe(2);
  });

  it("lets the own MERGE stand when a seat transcript read times out once and the seat then says MERGE", async () => {
    const seat = seatSaying("MERGE");
    let seatReads = 0;
    const earlier = tiedFailing(new Error("unused"));
    const reader: ReviewerReader = {
      read: async (input) => (input.reviewerSessionId !== SEAT.sessionId ? earlier.read(input) : ++seatReads === 1 ? Promise.reject(new ReviewerAskTimedOut("agent-chat timed out")) : seat.reader.read(input)),
    };

    const result = await unlessSeatFixFirst(tiedRoster, reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toBe(shepherdMerge);
    expect(seatReads).toBe(2);
  });

  it("still blocks at once on a damaged seat transcript, which no re-read can mend", async () => {
    const seat = seatSaying("MERGE");
    let seatReads = 0;
    const damaged = new DamagedTranscriptError("ends in a partial record", [said(SEAT, verdictAt("WAIT", OLD_HEAD), 1)], `Review ${REPO}#4`);
    const reader: ReviewerReader = { read: async () => ((seatReads += 1), Promise.reject(damaged)) };

    const result = await unlessSeatFixFirst(rosterOf(SEAT), reader, target, shepherdMerge, undefined, Date.now, seat.seatWait);

    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("could not be read") });
    expect(seatReads).toBe(1);
  });

  it("shows the hold in the review wait while the seat says WAIT, and clears it once the seat settles", async () => {
    const seat = seatSaying("WAIT", "MERGE");
    const seen: (string | undefined)[] = [];
    const timing = { ...seat.seatWait.timing, sleep: async (ms: number) => (seen.push(reviewWait(REPO, 4)), seat.seatWait.timing.sleep(ms)) };

    await unlessSeatFixFirst(rosterOf(SEAT), seat.reader, target, shepherdMerge, undefined, Date.now, { ...seat.seatWait, timing });

    expect(seen).toEqual([expect.stringContaining(`holding Shepherd's MERGE at ${HEAD} on the seat check: seat check: ${SEAT.name} said WAIT`)]);
    expect(reviewWait(REPO, 4)).toBeUndefined();
  });
});

describe("seat and hold reviewers: the findings a FIX_FIRST hands over", () => {
  const POSTSCRIPT = `A background search timed out. The verdict stands.\n\nVerdict: FIX_FIRST\nPR: ${REPO}#4\nHead: ${HEAD}\n`;
  const textOf = (result: unknown) => (result as { text: string }).text;

  it("keeps a hold reviewer's findings when a postscript restating the block follows them", () => {
    const result = acceptExternalVerdict({ ...target, external: SEAT.name }, SEAT, [said(SEAT, verdictAt("FIX_FIRST"), 2), said(SEAT, POSTSCRIPT, 3)]);

    expect(textOf(result)).toBe(`${verdictAt("FIX_FIRST")}${FINDINGS_SEPARATOR}${POSTSCRIPT}`);
  });

  it("keeps a seat reviewer's findings when a postscript restating the block follows them", async () => {
    const result = await seatFixFirst(rosterOf(SEAT), readerOf([said(SEAT, verdictAt("FIX_FIRST"), 5), said(SEAT, POSTSCRIPT, 6)]), target);

    expect(textOf(result)).toBe(`Seat reviewer ${SEAT.name} said FIX_FIRST at this head.\n\n${verdictAt("FIX_FIRST")}${FINDINGS_SEPARATOR}${POSTSCRIPT}`);
  });
});

describe("G10 disagreement between a seat reviewer and Shepherd", () => {
  const wiring = (...rows: ReviewerAgent[]) => ({ dispatch: { roster: rosterOf(...rows), spawn: async () => undefined, resume: async () => undefined }, reader: readerOf([]) }) as unknown as Parameters<typeof seatVetoed>[0];
  const withReader = (messages: ReviewerMessage[], ...rows: ReviewerAgent[]) => ({ ...wiring(...rows)!, reader: readerOf(messages) }) as Parameters<typeof seatVetoed>[0];
  const shepherdFixFirst: AwaitVerdictResult = { ...shepherdMerge, verdict: "FIX_FIRST", text: "rename" } as AwaitVerdictResult;
  const ownInput = { ...target, reviewerAgentId: SHEPHERD_RV.agentId, reviewerSessionId: SHEPHERD_RV.sessionId };
  const seatMerge: AwaitVerdictResult = { ...shepherdMerge, locator: locatorIn(SEAT.sessionId), reviewer: { agentId: SEAT.agentId, sessionId: SEAT.sessionId } };

  it("records a seat FIX_FIRST over Shepherd's MERGE on the verdict that sends the head back", async () => {
    const step = seatVetoed(withReader([said(SEAT, verdictAt("FIX_FIRST"), 5)], SEAT), async () => shepherdMerge, () => 77);

    expect(await step(ownInput, new AbortController().signal)).toMatchObject({ verdict: "FIX_FIRST", ownerOverride: { trigger: "g10-disagree", head: HEAD, shepherd: "MERGE", other: "FIX_FIRST", at: 77 } });
  });

  it("records a seat MERGE over Shepherd's FIX_FIRST and leaves the verdict standing", async () => {
    const step = seatVetoed(withReader([said(SEAT, verdictAt("MERGE"), 5)], SEAT), async () => shepherdFixFirst, () => 78);

    expect(await step(ownInput, new AbortController().signal)).toMatchObject({ verdict: "FIX_FIRST", ownerOverride: { trigger: "g10-disagree", shepherd: "FIX_FIRST", other: "MERGE", at: 78 } });
  });

  it("records nothing when the seat reviewer agrees with Shepherd", async () => {
    const merged = seatVetoed(withReader([said(SEAT, verdictAt("MERGE"), 5)], SEAT), async () => shepherdMerge);
    const sentBack = seatVetoed(withReader([said(SEAT, verdictAt("FIX_FIRST"), 5)], SEAT), async () => shepherdFixFirst);

    expect(await merged(ownInput, new AbortController().signal)).not.toHaveProperty("ownerOverride");
    expect(await sentBack(ownInput, new AbortController().signal)).not.toHaveProperty("ownerOverride");
  });

  it("is waited out inside the verdict step when seatVetoed is given the timing", async () => {
    const seat = seatSaying("WAIT", "MERGE");

    const step = seatVetoed({ ...wiring(SEAT)!, reader: seat.reader }, async () => shepherdMerge, Date.now, seat.seatWait.timing);

    expect(await step(ownInput, new AbortController().signal)).toMatchObject({ kind: "verdict", verdict: "MERGE", reviewer: { agentId: SHEPHERD_RV.agentId } });
    expect(seat.reads()).toBe(2);
  });

  describe("a verdict whose author is not the dispatched reviewer", () => {
    it("records no verdict when the body returns a seat reviewer's MERGE for Shepherd's own reviewer", async () => {
      const step = seatVetoed(wiring(SEAT), async () => seatMerge);

      expect(await step(ownInput, new AbortController().signal)).toEqual({ kind: "none", reason: expect.stringMatching(/not the dispatched reviewer/) });
    });

    it("records no verdict when only the session differs from the dispatched one", async () => {
      const step = seatVetoed(wiring(SEAT), async () => shepherdMerge);

      expect(await step({ ...ownInput, reviewerSessionId: "session-other" }, new AbortController().signal)).toMatchObject({ kind: "none", reason: expect.stringMatching(/not the dispatched reviewer/) });
    });

    it("records no verdict when the input names no dispatched reviewer", async () => {
      const step = seatVetoed(wiring(SEAT), async () => shepherdMerge);

      expect(await step(target, new AbortController().signal)).toMatchObject({ kind: "none", reason: expect.stringMatching(/not the dispatched reviewer/) });
    });

    it("guards the verdict even with no dispatch wired", async () => {
      const step = seatVetoed(undefined, async () => seatMerge);

      expect(await step(ownInput, new AbortController().signal)).toMatchObject({ kind: "none" });
    });

    it("passes the verdict through when the input names its author as the dispatched reviewer", async () => {
      const step = seatVetoed(wiring(), async () => seatMerge);

      expect(await step({ ...target, reviewerAgentId: SEAT.agentId, reviewerSessionId: SEAT.sessionId }, new AbortController().signal)).toMatchObject({ kind: "verdict", verdict: "MERGE", reviewer: { agentId: SEAT.agentId } });
    });

    it("passes an external review's verdict through, since Shepherd started nobody", async () => {
      const step = seatVetoed(wiring(), async () => seatMerge);

      expect(await step({ ...target, external: SEAT.name }, new AbortController().signal)).toMatchObject({ kind: "verdict", verdict: "MERGE", reviewer: { agentId: SEAT.agentId } });
    });
  });
});

describe("awaitExternalVerdict over a real transcript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-external-review-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** One read, then the deadline: what the hold's reviewer said by the first poll. */
  function awaitOnce(row: SeatRow) {
    const reader = transcriptReviewerReader({ roster: async () => [row], namespace: "host-a" });
    const timing = { now: () => 0, sleep: async () => undefined, pollMs: 1, timeoutMs: 0 };
    return awaitExternalVerdict(async () => [row], reader, { ...target, external: row.name }, timing, new AbortController().signal);
  }

  it("returns MERGE for a live reviewer whose verdict went out in a chat_send", async () => {
    const seat = seatTranscript(dir, "seat-c-9-review", "live").user("Review octo/demo#4.").send(verdictAt("MERGE"));

    expect(await awaitOnce(seat.row)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD, reviewer: { agentId: seat.row.agentId, sessionId: seat.row.sessionId } });
  });

  it("returns no verdict for an exited reviewer whose transcript ended in a partial record", async () => {
    const seat = seatTranscript(dir, "seat-c-9-review", "exited").user("Review octo/demo#4.").send(verdictAt("MERGE")).text("Sent.");
    appendFileSync(seat.file, '{"type":"assistant","message":{"role":', "utf8");

    expect(await awaitOnce(seat.row)).toEqual({ kind: "none" });
  });

  it("returns no verdict when the reviewer sent MERGE and died writing its FIX_FIRST", async () => {
    const seat = seatTranscript(dir, "seat-c-9-review", "exited").user("Review octo/demo#4.").send(verdictAt("MERGE"));
    appendFileSync(seat.file, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__plugin_agent-chat_agent-chat__chat_send","input":{"text":"Verdict: FIX_FIRST`, "utf8");

    expect(await awaitOnce(seat.row)).toEqual({ kind: "none" });
  });

  it("still lets the seat veto read the FIX_FIRST an exited reviewer sent before its transcript ended in a partial record", async () => {
    const seat = seatTranscript(dir, "seat-c-9-review", "exited").user("Review octo/demo#4.").send(verdictAt("MERGE")).send(verdictAt("FIX_FIRST"));
    appendFileSync(seat.file, '{"type":"assistant","message":{"role":', "utf8");
    const reader = transcriptReviewerReader({ roster: async () => [seat.row], namespace: "host-a" });

    expect(await seatFixFirst(rosterOf(seat.row), reader, target)).toMatchObject({ verdict: "FIX_FIRST" });
  });
});
