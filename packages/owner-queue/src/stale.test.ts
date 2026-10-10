import { describe, expect, it } from "vitest";
import { SHA_A, SHA_B, item } from "./test-fixtures.js";
import { staleLabel } from "./stale.js";

const PR = "org-a/repo-1#12";

/** An approve-merge gate pinned to the head the owner was asked about. */
function gate(sha: string = SHA_A) {
  return item({
    id: "gate:g-1",
    kind: "approve",
    lens: "blocking-merge",
    sources: [{ system: "hitl", ref: "g-1" }],
    keys: [`pr:${PR}@${sha}`, "gate:g-1", "task:PRJ1-7"],
  });
}

describe("staleLabel", () => {
  describe("worked cases", () => {
    it("labels a head-pinned approval stale once a new commit moves the head", () => {
      const label = staleLabel(gate(SHA_A), { prs: { [PR]: { state: "open", head: SHA_B } } });

      expect(label).toEqual({ status: "gone-elsewhere", rule: "head-moved", reason: `new-head:${SHA_B}` });
    });

    it("labels a gate stale when its PR merged but the gate stayed open", () => {
      const label = staleLabel(gate(SHA_A), { prs: { [PR]: { state: "merged", head: SHA_A } } });

      expect(label).toEqual({ status: "gone-elsewhere", rule: "pr-merged", reason: `pr-merged:${PR}` });
    });
  });

  it("leaves a gate open while its PR is open on the pinned head", () => {
    expect(staleLabel(gate(SHA_A), { prs: { [PR]: { state: "open", head: SHA_A } } })).toBeNull();
  });

  it("reports a merge, not the moved head, when a PR merged on a newer head", () => {
    const label = staleLabel(gate(SHA_A), { prs: { [PR]: { state: "merged", head: SHA_B } } });

    expect(label?.rule).toBe("pr-merged");
  });

  it("matches PR refs and heads case-insensitively", () => {
    const upper = gate(SHA_A.toUpperCase());

    expect(staleLabel(upper, { prs: { "Org-A/Repo-1#12": { state: "open", head: SHA_A } } })).toBeNull();
    expect(staleLabel(upper, { prs: { "Org-A/Repo-1#12": { state: "open", head: SHA_B.toUpperCase() } } })?.reason).toBe(
      `new-head:${SHA_B}`,
    );
  });

  it("never calls a head moved for an unpinned key, a short pin or a short live head", () => {
    const unpinned = item({ id: "chat:m-1", keys: [`pr:${PR}`] });
    const short = item({ id: "chat:m-2", keys: [`pr:${PR}@${SHA_A.slice(0, 7)}`] });

    expect(staleLabel(unpinned, { prs: { [PR]: { state: "open", head: SHA_B } } })).toBeNull();
    expect(staleLabel(short, { prs: { [PR]: { state: "open", head: SHA_B } } })).toBeNull();
    expect(staleLabel(gate(SHA_A), { prs: { [PR]: { state: "open", head: SHA_B.slice(0, 7) } } })).toBeNull();
  });

  it("labels an unpinned item stale when its PR merged", () => {
    const unpinned = item({ id: "chat:m-1", keys: [`pr:${PR}`] });

    expect(staleLabel(unpinned, { prs: { [PR]: { state: "merged" } } })?.reason).toBe(`pr-merged:${PR}`);
  });

  it("labels an item stale when a task it names is done", () => {
    const label = staleLabel(gate(SHA_A), { tasks: { "PRJ1-7": { status: "done" } } });

    expect(label).toEqual({ status: "gone-elsewhere", rule: "task-done", reason: "task-done:PRJ1-7" });
  });

  it("leaves an item open while its task is still in progress", () => {
    expect(staleLabel(gate(SHA_A), { tasks: { "PRJ1-7": { status: "in_progress" } } })).toBeNull();
  });

  it("never labels from absent evidence", () => {
    expect(staleLabel(gate(SHA_A), {})).toBeNull();
  });

  it("never relabels an item that is already closed", () => {
    const answered = { ...gate(SHA_A), status: "answered" as const };

    expect(staleLabel(answered, { prs: { [PR]: { state: "merged" } } })).toBeNull();
  });

  describe("retired asker", () => {
    const ask = item({ id: "chat:m-9", asker: "agent-a", keys: [] });
    const retired = { askers: { "agent-a": { retired: true } } };

    it("labels the ask stale once the asker retired having declared a default", () => {
      const label = staleLabel(ask, { ...retired, onNoAnswer: { "chat:m-9": "Ship the flat layout" } });

      expect(label).toEqual({ status: "gone-elsewhere", rule: "asker-retired", reason: "asker-retired:agent-a" });
    });

    it("keeps the ask open when its asker parked the work on the answer", () => {
      expect(staleLabel(ask, { ...retired, onNoAnswer: { "chat:m-9": "Parked" } })).toBeNull();
    });

    it("keeps the ask open when the asker declared no default", () => {
      expect(staleLabel(ask, retired)).toBeNull();
      expect(staleLabel(ask, { ...retired, onNoAnswer: { "chat:m-9": "  " } })).toBeNull();
    });

    it("keeps the ask open while the asker is live", () => {
      const live = { askers: { "agent-a": { retired: false } }, onNoAnswer: { "chat:m-9": "Ship it" } };

      expect(staleLabel(ask, live)).toBeNull();
    });
  });
});
