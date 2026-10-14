import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SEAT_REVIEWER, seatFixFirst } from "./external-review.js";
import type { ReviewerReader } from "./review.js";
import { awaitingTranscript, registeredOwners, rosterTie, type SeatRow } from "./seat-tie.js";

const target = { repo: "octo/demo", pr: 4, head: "a".repeat(40) };
const THIS_PR = { repo: "Octo/Demo", pr: 4, implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" };
const OTHER_PR = { repo: "octo/demo", pr: 5, implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b" };
const BRANCH_ONLY = { repo: "octo/demo", pr: null, implementer: "tc-tp-6-c", branch: "agent-chat/tc-tp-6-c" };
const storeOf = (rows: readonly (typeof THIS_PR | typeof BRANCH_ONLY)[]) => ({
  get: () => ({ byPr: (repo: string, pr: number) => rows.find((row) => row.pr === pr && row.repo.toLowerCase() === repo.toLowerCase()), all: () => rows }),
});

describe("registeredOwners", () => {
  it("names this PR's owner and every other registration, labelled by its PR or else its branch", () => {
    expect(registeredOwners(storeOf([THIS_PR, OTHER_PR, BRANCH_ONLY]), target)).toEqual({
      owner: { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" },
      others: [
        { implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: "octo/demo#5" },
        { implementer: "tc-tp-6-c", branch: "agent-chat/tc-tp-6-c", label: "octo/demo agent-chat/tc-tp-6-c" },
      ],
    });
  });

  it("gives nothing when the PR has no registration, so no reviewer can clear by another's", () => {
    expect(registeredOwners(storeOf([OTHER_PR]), target)).toEqual({});
  });

  it("gives nothing when the store cannot be read", () => {
    const unbound = {
      get: () => {
        throw new Error("not bound");
      },
    };

    expect(registeredOwners(unbound, target)).toEqual({});
  });
});

describe("rosterTie for a reviewer started in Shepherd's review checkout root", () => {
  /** Shepherd checks each PR out under ~/.cache/pc-reviews/<owner>-<repo>-<pr>, and a reviewer may run in a leaf named for itself under it. */
  const reviews = (...leaves: string[]) => path.join(os.homedir(), ".cache", "pc-reviews", ...leaves);
  const owner = { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" };
  const others = [{ implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: "octo/demo#5" }];
  const row = (name: string, cwd: string): SeatRow => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "exited", spawnedBy: "coord", cwd });
  const stem = (name: string) => name.replace(SEAT_REVIEWER, "");
  const failing: ReviewerReader = { read: async () => Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })) };

  it.each([
    ["the PR's checkout", row("rv-octo-demo-4-review", reviews("octo-demo-4"))],
    ["a leaf named for the reviewer", row("rv-octo-demo-4-review", reviews("octo-demo-4", "rv-octo-demo-4-review"))],
  ])("finds no tie, and the seat check blocks with a retry, when this PR's reviewer runs in %s that no registration names", async (_label, reviewer) => {
    const at = { ...target, owner, others };

    expect(rosterTie(at, [reviewer], stem)).toMatchObject({ kind: "none" });
    expect(await seatFixFirst(async () => [reviewer], failing, at, vi.fn())).toMatchObject({ kind: "none", retry: true, reason: expect.stringContaining(reviewer.name) });
  });

  it("ties a leaf that is another registered PR's implementer to that PR only through its registration", async () => {
    const reviewer = row("rv-octo-demo-4-review", reviews("octo-demo-4", "tc-tp-5-b"));
    const warn = vi.fn();

    expect(rosterTie({ ...target, owner, others }, [reviewer], stem)).toEqual({ kind: "other", pr: "octo/demo#5" });
    expect(await seatFixFirst(async () => [reviewer], failing, { ...target, owner, others }, warn)).toEqual({ kind: "clear" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the roster ties it to octo/demo#5's registration"));
    expect(rosterTie({ ...target, owner, others: [] }, [reviewer], stem)).toMatchObject({ kind: "none" });
    expect(await seatFixFirst(async () => [reviewer], failing, { ...target, owner }, vi.fn())).toMatchObject({ kind: "none", retry: true });
  });
});

describe("awaitingTranscript", () => {
  const row = (extra: Partial<SeatRow> = {}): SeatRow => ({ name: "tc-tp-9-a-review", agentId: "a1", sessionId: "s1", presence: "live", spawnedBy: null, ...extra });

  it("returns the newest row when it has no transcript yet", () => {
    const pending = row({ transcriptExists: false });
    expect(awaitingTranscript([row({ transcriptExists: true }), pending])).toBe(pending);
  });

  it("returns the newest row when it has no session yet", () => {
    const unstarted = row({ sessionId: "" });
    expect(awaitingTranscript([unstarted])).toBe(unstarted);
  });

  it("ignores an older row whose transcript is gone", () => {
    expect(awaitingTranscript([row({ transcriptExists: false }), row({ sessionId: "s2", transcriptExists: true })])).toBeUndefined();
  });

  it("ignores a row from a port that does not report transcriptExists", () => {
    expect(awaitingTranscript([row()])).toBeUndefined();
  });
});
