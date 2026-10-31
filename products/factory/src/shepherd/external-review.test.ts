import { fakeSha } from "@titan-design/github";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seatTranscript, type SeatRow } from "../test-support/seat-transcript.js";
import type { AwaitVerdictResult, ReviewWiring } from "./review.js";
import { FINDINGS_SEPARATOR, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "@titan-design/review-panel";
import { BrokerUnavailableError, DispatchError, DispatchTimeoutError } from "@titan-design/agent-dispatch";
import { ReviewerAskTimedOut, ReviewerBrokerBusy, ReviewerBrokerDown, reviewWait } from "./review-wait.js";
import { transcriptReviewerReader } from "./reviewer-reader.js";
import { DamagedTranscriptError, acceptExternalVerdict, awaitExternalVerdict, SEAT_REVIEWER, newestAtHead, seatFixFirst, seatVetoed, unlessSeatFixFirst } from "./external-review.js";
import { readPath } from "../narrow.js";
import { fakeLocator } from "../test-support/fakes.js";

const REPO = "octo/demo";
const HEAD = fakeSha("seat-verdict-head");
const OLD_HEAD = fakeSha("seat-verdict-old-head");
const target = { repo: REPO, pr: 4, head: HEAD };

const agent = (name: string, session = `session-${name}`): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: session, presence: "exited", spawnedBy: "coord" });
const locatorIn = (nativeId: string) => fakeLocator({ source: { conversation: { nativeId } } });
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
/** PR 5 as Shepherd registered it: opened by `seat-z-1`, in its own worktree. */
const OTHER_PR = { implementer: "seat-z-1", branch: "agent-chat/seat-z-1", label: `${REPO}#5` };
/** The PR as Shepherd registered it: opened by the implementer `seat-c-9`, whose seat reviewer is `seat-c-9-review`, beside PR 5. */
const owned = { ...target, owner: { implementer: "seat-c-9", branch: "agent-chat/seat-c-9" }, others: [OTHER_PR] };
/** The row as the roster lists an agent started in PR 5's implementer's worktree. */
const elsewhere = <T extends ReviewerAgent>(row: T) => ({ ...row, cwd: "/srv/work/demo/.worktrees/seat-z-1" });
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
    expect(readPath(result, "text")).toContain("Seat reviewer seat-c-9-review said FIX_FIRST");
    expect(readPath(result, "text")).toContain("Findings.");
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
    const slow = new DispatchTimeoutError("agent-chat refused agent ls: broker did not answer agents_result");
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

      expect(await unlessSeatFixFirst(rosterOf(elsewhere(unrelated), SEAT), reader, owned, shepherdMerge, warn)).toEqual(shepherdMerge);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${unrelated.name} is not the reviewer of ${REPO}#4`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("printed invalid JSON"));
    });

    it("blocks with a retry when an untied reviewer's read fails in a way that may clear, since it may be this PR's own", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(unrelated, SEAT), unrelatedFailing, target, warn)).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${unrelated.name} could not be read: DispatchTimeoutError: agent-chat refused agent ls: broker did not answer agents_result`,
        retry: true,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("no longer treats a plain DispatchError carrying the broker's no-reply text as transient", async () => {
      const plain = new DispatchError("agent-chat refused agent ls: broker did not answer agents_result");
      const reader: ReviewerReader = { read: async (input) => (input.reviewerAgentId === unrelated.agentId ? Promise.reject(plain) : []) };
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(elsewhere(unrelated), SEAT), reader, owned, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${unrelated.name} is not the reviewer of`));
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
        reason: `seat check: the transcript of ${SEAT.name} could not be read: DispatchTimeoutError: agent-chat refused agent ls: broker did not answer agents_result`,
        retry: true,
      });
    });

    it("blocks its own PR without a retry when the refusal will read the same again", async () => {
      const refused = new DispatchError("agent-chat agent ls --json printed invalid JSON");

      expect(await seatFixFirst(tiedRoster, tiedFailing(refused), target, vi.fn())).toEqual({ kind: "none", reason: `seat check: the transcript of ${SEAT.name} could not be read: DispatchError: agent-chat agent ls --json printed invalid JSON` });
    });

    it("keeps no home path, URL or token from the error's text in the reason", async () => {
      const leaky = new DispatchError(`profile at /home/runner/.agent-chat/x.json via https://db.example.invalid/x ghp_FAKE0000SECRET`);

      const check = await seatFixFirst(async () => Promise.reject(leaky), readerOf([]), target);

      expect(check).toEqual({ kind: "none", reason: "seat check: the roster could not be read: DispatchError: profile at ~/.agent-chat/x.json via [url] [redacted]" });
    });
  });

  describe("a single-session seat reviewer whose read fails the same every time and shows nothing", () => {
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const failing: ReviewerReader = { read: async () => Promise.reject(missing) };
    const owner = { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" };
    const task = { ...target, owner, others: [{ implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: `${REPO}#5` }] };
    const untied = (name: string, missing: string) => `seat check: the transcript of ${name} could not be read and nothing says whose reviewer it is (no record names a PR; ${missing}): Error`;

    it("blocks the PR whose implementer the roster names as the reviewer's", async () => {
      const own = agent("tc-tp-9-a-review");
      const check = await seatFixFirst(rosterOf(own), failing, task, vi.fn());

      expect(check).toEqual({ kind: "none", reason: "seat check: the transcript of tc-tp-9-a-review could not be read and the roster ties it to this PR's implementer: Error" });
    });

    it("blocks the PR whose worktree the roster says the reviewer ran in, whatever its name", async () => {
      const own = { ...agent("x-review"), cwd: "/srv/work/demo/.worktrees/tc-tp-9-a" };

      expect(await seatFixFirst(rosterOf(own), failing, task, vi.fn())).toMatchObject({ kind: "none", reason: expect.stringContaining("ties it to this PR's implementer") });
    });

    it("clears with a warning when the roster places the reviewer in another registered PR's worktree, as for an old reviewer whose transcript was deleted", async () => {
      const other = { ...agent("x-review"), cwd: "/srv/work/demo/.worktrees/tc-tp-5-b" };
      const warn = vi.fn();

      expect(await unlessSeatFixFirst(rosterOf(other), failing, task, shepherdMerge, warn)).toEqual(shepherdMerge);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${other.name} is not the reviewer of ${REPO}#4 (the roster ties it to ${REPO}#5's registration)`));
    });

    it("clears with a warning when the reviewer's name stem is another registered PR's implementer", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(agent("tc-tp-5-b-review")), failing, task, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`tc-tp-5-b-review is not the reviewer of ${REPO}#4 (the roster ties it to ${REPO}#5's registration)`));
    });

    it.each([
      ["a directory no registration owns", { ...agent("rv-tp-9-a-review"), cwd: "/srv/work/demo/.worktrees/rv-tp-9-a-review" }, task, 'no registration\'s implementer or branch is "rv-tp-9-a" or "rv-tp-9-a-review"'],
      ["a scratch directory", { ...agent("bd-tp-9-review"), cwd: "/tmp/ac-x/scratch" }, task, 'no registration\'s implementer or branch is "bd-tp-9" or "scratch"'],
      ["a stem the registration does not name", agent("tc-tp-9-a-review"), { ...task, owner: { implementer: "titan-coord", branch: "fix/tp-9" } }, 'no registration\'s implementer or branch is "tc-tp-9-a"'],
      ["only the repo's shared checkout", { ...agent("tc-tp-7-c-review"), cwd: "/srv/work/demo" }, task, 'no registration\'s implementer or branch is "tc-tp-7-c"'],
      ["no registration for the PR", { ...agent("tc-tp-5-b-review"), cwd: "/srv/work/demo/.worktrees/tc-tp-5-b" }, target, `Shepherd holds no registration for ${REPO}#4`],
    ])("blocks with a retry, naming the reviewer and the missing evidence, when the roster gives %s", async (_label, row, at, missing) => {
      const check = await seatFixFirst(rosterOf(row), failing, at, vi.fn());

      expect(check).toEqual({ kind: "none", reason: untied(row.name, missing), retry: true });
    });

    it("holds Shepherd's MERGE for the next round, naming the reviewer and the missing evidence, when none turns up within the seat wait", async () => {
      let clock = 0;
      const seatWait = { timing: { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: SEAT_POLL_MS, timeoutMs: SEAT_BOUND_MS }, signal: new AbortController().signal };

      const result = await unlessSeatFixFirst(rosterOf(agent("tc-tp-7-c-review")), failing, task, shepherdMerge, vi.fn(), Date.now, seatWait);

      expect(result).toEqual({ kind: "none", reason: untied("tc-tp-7-c-review", 'no registration\'s implementer or branch is "tc-tp-7-c"'), seatHeld: shepherdMerge });
    });
  });

  describe("a seat reviewer tied to this PR with no transcript yet", () => {
    const owner = { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" };
    const task = { ...target, owner, others: [{ implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: `${REPO}#5` }] };
    const nothing: ReviewerReader = { read: async () => [] };
    const pending = (name: string, more: Record<string, unknown> = {}) => ({ ...agent(name), presence: "live" as const, transcriptExists: false, ...more });
    const timed = () => {
      let clock = 0;
      return { timing: { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: SEAT_POLL_MS, timeoutMs: SEAT_BOUND_MS }, signal: new AbortController().signal };
    };

    it("blocks with a retry, naming the reviewer and its presence, when the canonical name has no transcript", async () => {
      const check = await seatFixFirst(rosterOf(pending("tc-tp-9-a-review")), nothing, task, vi.fn());

      expect(check).toEqual({ kind: "none", reason: "seat check: tc-tp-9-a-review is this PR's reviewer and has no transcript yet (live)", retry: true });
    });

    it("blocks when only the worktree ties the reviewer to this PR", async () => {
      const row = pending("x-review", { cwd: "/srv/work/demo/.worktrees/tc-tp-9-a" });

      expect(await seatFixFirst(rosterOf(row), nothing, task, vi.fn())).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining("no transcript yet") });
    });

    it("blocks, and still visits the name, when its only row has no session yet", async () => {
      const row = { ...pending("tc-tp-9-a-review"), sessionId: "" };

      expect(await seatFixFirst(rosterOf(row), nothing, task, vi.fn())).toMatchObject({ kind: "none", retry: true });
    });

    it("blocks through the real transcript reader, which reads nothing from a row without a file", async () => {
      const row = { ...pending("tc-tp-9-a-review"), transcriptPath: null };
      const reader = transcriptReviewerReader({ roster: async () => [row], namespace: "host-a" });

      expect(await seatFixFirst(rosterOf(row), reader, task, vi.fn())).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining("no transcript yet") });
    });

    it("lets Shepherd's MERGE stand once the reviewer's transcript appears and says MERGE", async () => {
      let rosterReads = 0;
      const roster = async () => ((rosterReads += 1), [rosterReads <= 2 ? pending(SEAT.name) : { ...agent(SEAT.name), transcriptExists: true }]);
      const reader: ReviewerReader = { read: async () => [said(SEAT, verdictAt("MERGE"), 6)] };

      const result = await unlessSeatFixFirst(roster, reader, { ...target, owner: { implementer: "seat-c-9", branch: null } }, shepherdMerge, vi.fn(), Date.now, timed());

      expect(result).toBe(shepherdMerge);
      expect(rosterReads).toBe(3);
    });

    it("holds Shepherd's MERGE as seatHeld when no transcript appears within the seat wait", async () => {
      const result = await unlessSeatFixFirst(rosterOf(pending("tc-tp-9-a-review")), nothing, task, shepherdMerge, vi.fn(), Date.now, timed());

      expect(result).toEqual({ kind: "none", reason: expect.stringContaining("no transcript yet"), seatHeld: shepherdMerge });
    });

    it.each([
      ["another PR's reviewer", pending("tc-tp-5-b-review"), task],
      ["a reviewer no registration owns", pending("zz-review"), task],
      ["a PR with no registration", pending("tc-tp-9-a-review"), target],
      ["a port that does not report transcriptExists", { ...agent("tc-tp-9-a-review"), presence: "live" as const }, task],
    ])("clears for %s", async (_label, row, at) => {
      expect(await seatFixFirst(rosterOf(row), nothing, at, vi.fn())).toEqual({ kind: "clear" });
    });

    it("clears when only an older session of the name lacks its transcript", async () => {
      const newest = { ...agent("tc-tp-9-a-review", "session-new"), transcriptExists: true };
      const older = { ...pending("tc-tp-9-a-review"), sessionId: "session-old" };

      expect(await seatFixFirst(rosterOf(newest, older), nothing, task, vi.fn())).toEqual({ kind: "clear" });
    });

    it("prefers another seat's FIX_FIRST over the pending reviewer", async () => {
      const reader: ReviewerReader = { read: async (input) => (input.reviewerAgentId === SEAT.agentId ? [said(SEAT, verdictAt("FIX_FIRST"), 5)] : []) };

      const check = await seatFixFirst(rosterOf(pending("tc-tp-9-a-review"), SEAT), reader, task, vi.fn());

      expect(check).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", reviewer: { agentId: SEAT.agentId } });
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

    it("warns without blocking when the damaged transcript names no PR and the roster places the reviewer elsewhere", async () => {
      const warn = vi.fn();

      expect(await seatFixFirst(rosterOf(elsewhere(damaged)), damagedReader([said(damaged, "Reading the diff.", 2)]), owned, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledOnce();
    });

    it("blocks with a retry when the damaged transcript names no PR and nothing else says whose reviewer it is", async () => {
      const check = await seatFixFirst(rosterOf(damaged), damagedReader([said(damaged, "Reading the diff.", 2)]), target, vi.fn());

      expect(check).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining(`Shepherd holds no registration for ${REPO}#4`) });
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

    it("clears by the brief Review octo/demo#40 now., which names another PR's number", async () => {
      expect(await seatFixFirst(rosterOf(damaged), damagedReader([], "Review octo/demo#40 now."), target, vi.fn())).toEqual({ kind: "clear" });
    });

    it.each([`Review other/demo#4 now.`, `Review octo/demo-x#4 now.`, `Review tp#4 at head`, `Review #4 at head`, `Review pull/4 now.`, `Review demo#5, then tp#4`])(
      "neither ties nor clears by the brief %s, whose PR number may be this one's, so it blocks with a retry",
      async (brief) => {
        expect(await seatFixFirst(rosterOf(damaged), damagedReader([], brief), target, vi.fn())).toMatchObject({ kind: "none", retry: true });
      },
    );

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

      it("warns without blocking when neither session ties the name to the PR and the roster places it elsewhere", async () => {
        const warn = vi.fn();

        expect(await seatFixFirst(rosterOf(elsewhere(first), elsewhere(second)), twoSessions([said(first, "Reading.", 5)]), owned, warn)).toEqual({ kind: "clear" });
        expect(warn).toHaveBeenCalledOnce();
      });

      /** Session 1 is whole with a MERGE for PR 5; session 2, a resume that may be reviewing PR 4, fails with `failure`. */
      const resumedFailing = (failure: unknown): ReviewerReader => ({
        read: async (input) => (input.reviewerSessionId === second.sessionId ? Promise.reject(failure) : [said(first, `Findings.\n\nVerdict: MERGE\nPR: ${REPO}#5\nHead: ${OLD_HEAD}\n`, 5)]),
      });
      const unownedTarget = { ...owned, owner: { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" } };

      it.each([
        ["ENOENT", Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })],
        ["EACCES", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })],
        ["SyntaxError", new SyntaxError("Unexpected token")],
      ])("blocks with a retry when session 2's read fails with %s and only session 1 names another PR", async (_label, failure) => {
        expect(await seatFixFirst(rosterOf(first, second), resumedFailing(failure), target, vi.fn())).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining(first.name) });
        expect(await seatFixFirst(rosterOf(first, second), resumedFailing(failure), unownedTarget, vi.fn())).toMatchObject({ kind: "none", retry: true });
      });

      it("blocks with a retry when damaged session 2's own records name no PR and only session 1 names another", async () => {
        expect(await seatFixFirst(rosterOf(first, second), resumedFailing(torn([said(second, "Reading.", 9)])), target, vi.fn())).toMatchObject({ kind: "none", retry: true });
      });

      it("ties the name by the failed session's roster row only, never a readable sibling's", async () => {
        const readable = { ...agent("bd-x-review", "s1"), cwd: "/w/tc-tp-5-b" };
        const failed = agent("bd-x-review", "s2");
        const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        const reader: ReviewerReader = { read: async (input) => (input.reviewerSessionId === failed.sessionId ? Promise.reject(denied) : [said(readable, "Reading.", 5)]) };
        const at = { ...target, owner: { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" }, others: [{ implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: `${REPO}#5` }] };

        expect(await seatFixFirst(rosterOf(readable, failed), reader, at, vi.fn())).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining("bd-x-review") });
        const failedInOther = { ...failed, cwd: "/w/tc-tp-5-b" };
        expect(await seatFixFirst(rosterOf(agent("bd-x-review", "s1"), failedInOther), reader, at, vi.fn())).toEqual({ kind: "clear" });
      });

      it.each([
        ["session 1 damaged with a brief for PR 5, session 2 EACCES", torn([], `Review ${REPO}#5 now.`), new Error("EACCES: permission denied")],
        ["both damaged, session 2 with no brief and no records", torn([], `Review ${REPO}#5 now.`), torn([], null)],
      ])("blocks with a retry when %s", async (_label, one, two) => {
        const reader: ReviewerReader = { read: async (input) => Promise.reject(input.reviewerSessionId === second.sessionId ? two : one) };

        expect(await seatFixFirst(rosterOf(first, second), reader, target, vi.fn())).toMatchObject({ kind: "none", retry: true });
      });

      it("blocks a damaged session whose brief names this PR beside another", async () => {
        expect(await seatFixFirst(rosterOf(first, second), resumedFailing(torn([], `Review ${REPO}#4 plus #5`)), target, vi.fn())).toMatchObject({ kind: "none" });
      });

      it("warns without blocking when damaged session 2's own brief names another PR", async () => {
        const warn = vi.fn();

        expect(await seatFixFirst(rosterOf(first, second), resumedFailing(torn([], `Review ${REPO}#5 now.`)), target, warn)).toEqual({ kind: "clear" });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("its records name another PR"));
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
  const textOf = (result: unknown) => String(readPath(result, "text"));

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
  const wiring = (...rows: ReviewerAgent[]) => partialFake<NonNullable<Parameters<typeof seatVetoed>[0]>>({ dispatch: { roster: rosterOf(...rows), spawn: async () => undefined, resume: async () => undefined }, reader: readerOf([]) });
  const withReader = (messages: ReviewerMessage[], ...rows: ReviewerAgent[]) => ({ ...wiring(...rows), reader: readerOf(messages) }) as Parameters<typeof seatVetoed>[0];
  const shepherdFixFirst: AwaitVerdictResult = { ...shepherdMerge, verdict: "FIX_FIRST", text: "rename" };
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

  it("ties or unties an unreadable seat reviewer by the PR's registered owner when seatVetoed is given one", async () => {
    const stale = elsewhere(agent("seat-z-1-review"));
    const unreadable = { ...wiring(stale), reader: { read: async () => Promise.reject(new Error("ENOENT")) } } as Parameters<typeof seatVetoed>[0];
    const ownersOf = vi.fn(() => ({ owner: owned.owner, others: owned.others }));

    const registered = await seatVetoed(unreadable, async () => shepherdMerge, Date.now, undefined, ownersOf)(ownInput, new AbortController().signal);
    const unregistered = await seatVetoed(unreadable, async () => shepherdMerge)(ownInput, new AbortController().signal);

    expect(registered).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(ownersOf).toHaveBeenCalledWith({ repo: REPO, pr: 4, head: HEAD });
    expect(unregistered).toMatchObject({ kind: "none", reason: expect.stringContaining("nothing says whose reviewer it is") });
  });

  it("is waited out inside the verdict step when seatVetoed is given the timing", async () => {
    const seat = seatSaying("WAIT", "MERGE");

    const step = seatVetoed({ ...wiring(SEAT), reader: seat.reader }, async () => shepherdMerge, Date.now, seat.seatWait.timing);

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

describe("awaitExternalVerdict with an unreadable roster", () => {
  it("logs that the roster could not be read and returns no verdict", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reader = { read: async () => [] };
    const timing = { now: () => 0, sleep: async () => undefined, pollMs: 1, timeoutMs: 0 };

    const result = await awaitExternalVerdict(() => Promise.reject(new Error("broker down")), reader, { ...target, external: "seat-c-9-review" }, timing, new AbortController().signal);

    expect(result).toEqual({ kind: "none" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("roster could not be read"));
    log.mockRestore();
  });
});

describe("seat check roster reads", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "titan-seat-roster-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the roster once for two seat reviewers, and a later roster failure cannot turn the verdict into none", async () => {
    const first = seatTranscript(dir, "seat-a-1-review", "exited").user("Review octo/demo#4.").send(verdictAt("FIX_FIRST"));
    const second = seatTranscript(dir, "seat-b-2-review", "exited").user("Review octo/demo#4.").send(verdictAt("MERGE"));
    const rows = [first.row, second.row];
    let calls = 0;
    const roster = async () => {
      if (++calls > 1) throw new ReviewerAskTimedOut("broker did not answer agents_result");
      return rows;
    };
    const reader = transcriptReviewerReader({ roster, namespace: "host-a" });

    const check = await seatFixFirst(roster, reader, target, vi.fn());

    expect(calls).toBe(1);
    expect(check).toMatchObject({ verdict: "FIX_FIRST" });
  });
});

describe("the author's profile when the roster fails after the seat check", () => {
  it("logs the unknown profile and records the verdict without one", async () => {
    let reads = 0;
    const roster = async () => (++reads === 1 ? [] : Promise.reject(new Error("broker down")));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const step = seatVetoed(partialFake<ReviewWiring>({ dispatch: partialFake<ReviewerDispatch>({ roster }), reader: readerOf([]) }), async () => shepherdMerge);

    const result = await step({ ...target, reviewerAgentId: SHEPHERD_RV.agentId, reviewerSessionId: SHEPHERD_RV.sessionId }, new AbortController().signal);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(result).not.toHaveProperty("reviewerProfile");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("profile is unknown"));
    log.mockRestore();
  });
});
