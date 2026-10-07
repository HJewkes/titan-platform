import { describe, expect, it } from "vitest";
import { SHA_A, SHA_B, item } from "./test-fixtures.js";
import { mergeByKeys } from "./merge.js";

const PR_AT_A = `pr:org-a/repo-1#12@${SHA_A}`;
const PR_AT_B = `pr:org-a/repo-1#12@${SHA_B}`;

function gate(keys: string[]) {
  return item({ id: "gate:g-1", sources: [{ system: "hitl", ref: "g-1" }], kind: "approve", keys });
}

function chat(keys: string[]) {
  return item({ id: "chat:m-1", sources: [{ system: "agent-chat", ref: "m-1" }], kind: "approve", keys });
}

describe("mergeByKeys", () => {
  it("merges two sources that name the same PR at the same head sha", () => {
    const merged = mergeByKeys([gate([PR_AT_A]), chat([PR_AT_A])]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("gate:g-1");
    expect(merged[0]?.sources).toEqual([
      { system: "hitl", ref: "g-1" },
      { system: "agent-chat", ref: "m-1" },
    ]);
  });

  it("keeps the same PR at two different head shas apart", () => {
    const merged = mergeByKeys([gate([PR_AT_A]), chat([PR_AT_B])]);

    expect(merged.map((each) => each.id)).toEqual(["gate:g-1", "chat:m-1"]);
  });

  it("keeps two heads of one PR apart even when they share a task key", () => {
    const merged = mergeByKeys([gate([PR_AT_A, "task:PRJ1-7"]), chat([PR_AT_B, "task:PRJ1-7"])]);

    expect(merged).toHaveLength(2);
  });

  it.each([
    ["a PR ref with no head sha", "pr:org-a/repo-1#12"],
    ["a PR ref with an empty sha", "pr:org-a/repo-1#12@"],
    ["a bare kind with no id", "task:"],
    ["an unknown key kind", "seat:seat-a"],
  ])("never merges on %s", (_label, key) => {
    const merged = mergeByKeys([gate([key]), chat([key])]);

    expect(merged).toHaveLength(2);
  });

  it("never merges a short sha with the full sha it abbreviates", () => {
    const merged = mergeByKeys([gate([`pr:org-a/repo-1#12@${SHA_A.slice(0, 7)}`]), chat([PR_AT_A])]);

    expect(merged).toHaveLength(2);
  });

  it.each([
    ["one sha is uppercase", PR_AT_A, `pr:org-a/repo-1#12@${SHA_B.toUpperCase()}`],
    ["the owner/repo case differs", `pr:Org-A/Repo-1#12@${SHA_A}`, PR_AT_B],
    ["one PR key has no sha", PR_AT_A, "pr:org-a/repo-1#12"],
    ["both carry the same short sha", `pr:org-a/repo-1#12@${SHA_A.slice(0, 7)}`, `pr:org-a/repo-1#12@${SHA_A.slice(0, 7)}`],
  ])("keeps one PR apart through a shared task key when %s", (_label, first, second) => {
    const merged = mergeByKeys([gate([first, "task:PRJ1-7"]), chat([second, "task:PRJ1-7"])]);

    expect(merged).toHaveLength(2);
  });

  it("never merges on two identical short shas", () => {
    const short = `pr:org-a/repo-1#12@${SHA_A.slice(0, 7)}`;

    expect(mergeByKeys([gate([short]), chat([short])])).toHaveLength(2);
  });

  it("merges one head written in two cases", () => {
    const merged = mergeByKeys([gate([`pr:Org-A/Repo-1#12@${SHA_A.toUpperCase()}`]), chat([PR_AT_A])]);

    expect(merged).toHaveLength(1);
  });

  it("merges transitively through a shared task key and a shared gate key", () => {
    const morning = item({ id: "morning:seat-a:1", sources: [{ system: "morning", ref: "seat-a:1" }], keys: ["gate:g-1"] });

    const merged = mergeByKeys([chat(["task:PRJ1-7"]), gate(["task:PRJ1-7", "gate:g-1"]), morning]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sources.map((source) => source.system)).toEqual(["agent-chat", "hitl", "morning"]);
  });

  it("unions keys and unblocks, keeps the earliest open time and a one-way door", () => {
    const first = item({ id: "a", keys: ["run:r-1"], unblocks: ["task:PRJ1-1"], openedAt: "2026-01-02T00:00:00Z" });
    const second = item({
      id: "b",
      keys: ["run:r-1", "task:PRJ1-2"],
      unblocks: ["task:PRJ1-1", "task:PRJ1-3"],
      door: "one-way",
      openedAt: "2026-01-01T00:00:00Z",
    });

    const [merged] = mergeByKeys([first, second]);

    expect(merged).toMatchObject({
      id: "a",
      keys: ["run:r-1", "task:PRJ1-2"],
      unblocks: ["task:PRJ1-1", "task:PRJ1-3"],
      door: "one-way",
      openedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("returns items with no shared key unchanged and in input order", () => {
    const items = [item({ id: "x", keys: ["task:PRJ1-1"] }), item({ id: "y", keys: ["task:PRJ1-2"] })];

    expect(mergeByKeys(items)).toEqual(items);
  });
});
