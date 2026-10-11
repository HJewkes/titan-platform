import { describe, expect, it } from "vitest";
import { SHA_A, SHA_B, item } from "./test-fixtures.js";
import { supersede, stackContext } from "./supersede.js";
import type { OwnerItem } from "./schema.js";

const PR = "org-a/repo-1#12";
const SHA_C = "c".repeat(40);
const ROUND_ANSWERER = { class: "owner", id: "owner", channel: "round" };

function onHead(id: string, sha: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return item({ id, kind: "approve", keys: [`pr:${PR}@${sha}`], ...overrides });
}

function ids(items: readonly OwnerItem[]): string[] {
  return items.map((each) => each.id);
}

describe("supersede", () => {
  it("withdraws items on an older head when the newest item names a new head", () => {
    const old = onHead("batch-8", SHA_A, { openedAt: "2026-01-01T00:00:00Z" });
    const fresh = onHead("batch-9", SHA_B, { openedAt: "2026-01-02T00:00:00Z" });

    const result = supersede([old, fresh]);

    expect(ids(result.kept)).toEqual(["batch-9"]);
    expect(result.withdrawn).toEqual([
      { item: { ...old, status: "withdrawn" }, was: "open", pr: PR, reason: `new-head:${SHA_B}` },
    ]);
    expect(result.heads).toEqual({ [PR]: SHA_B });
  });

  it("takes the live head from heads[pr] over the newest item", () => {
    const result = supersede([onHead("a", SHA_A), onHead("b", SHA_B)], { [PR]: SHA_C });

    expect(result.kept).toEqual([]);
    expect(result.withdrawn.map((each) => each.reason)).toEqual([`new-head:${SHA_C}`, `new-head:${SHA_C}`]);
  });

  it("matches heads[pr] case-insensitively and ignores a short sha there", () => {
    const old = onHead("old", SHA_A, { openedAt: "2026-01-01T00:00:00Z" });
    const fresh = onHead("fresh", SHA_B, { openedAt: "2026-01-02T00:00:00Z" });

    expect(ids(supersede([old, fresh], { "Org-A/Repo-1#12": SHA_A.toUpperCase() }).kept)).toEqual(["old"]);
    expect(ids(supersede([old, fresh], { [PR]: SHA_A.slice(0, 7) }).kept)).toEqual(["fresh"]);
  });

  it("does not count an answer at a superseded head as approval at the live head", () => {
    const approved = onHead("ship-old", SHA_A, {
      status: "answered",
      answer: { optionId: "ship", by: ROUND_ANSWERER, at: "2026-01-01T01:00:00Z" },
    });

    const result = supersede([approved], { [PR]: SHA_B });

    expect(result.kept).toEqual([]);
    expect(result.withdrawn[0]).toMatchObject({ was: "answered", item: { status: "withdrawn" } });
  });

  it("keeps a change request on an old head readable as context, not as an open block", () => {
    const changes = onHead("changes-old", SHA_A, {
      status: "answered",
      answer: { changeRequested: true, text: "Tighten spacing", by: ROUND_ANSWERER, at: "2026-01-01T01:00:00Z" },
    });

    const result = supersede([changes], { [PR]: SHA_B });

    expect(result.kept).toEqual([]);
    expect(result.withdrawn[0]?.item.answer).toEqual(changes.answer);
    expect(result.withdrawn[0]?.item.status).toBe("withdrawn");
  });

  it("keeps a change request re-asserted at the live head", () => {
    const reasserted = onHead("changes-new", SHA_B, {
      status: "answered",
      answer: { changeRequested: true, by: ROUND_ANSWERER, at: "2026-01-03T00:00:00Z" },
    });

    expect(ids(supersede([onHead("changes-old", SHA_A), reasserted], { [PR]: SHA_B }).kept)).toEqual(["changes-new"]);
  });

  it.each([
    ["an unpinned PR key", `pr:${PR}`],
    ["a short-sha PR key", `pr:${PR}@${SHA_A.slice(0, 7)}`],
    ["no PR key", "task:PRJ1-7"],
  ])("never withdraws an item with %s", (_label, key) => {
    const result = supersede([item({ id: "x", keys: [key] })], { [PR]: SHA_B });

    expect(ids(result.kept)).toEqual(["x"]);
  });

  it("leaves an already closed item as it is", () => {
    const expired = onHead("gone", SHA_A, { status: "expired" });

    expect(supersede([expired], { [PR]: SHA_B }).kept).toEqual([expired]);
  });

  it("lets the later item in input order set the head on equal openedAt", () => {
    expect(ids(supersede([onHead("first", SHA_A), onHead("second", SHA_B)]).kept)).toEqual(["second"]);
  });

  it("treats each PR on its own", () => {
    const other = item({ id: "other", keys: [`pr:org-a/repo-1#13@${SHA_A}`] });

    expect(ids(supersede([other, onHead("this", SHA_A)], { [PR]: SHA_B }).kept)).toEqual(["other"]);
  });
});

describe("stackContext", () => {
  const A = "org-a/repo-1#1";
  const B = "org-a/repo-1#2";
  const C = "org-a/repo-1#3";
  const onPr = (id: string, pr: string) => item({ id, keys: [`pr:${pr}@${SHA_A}`] });

  it("gives an item on a stacked PR its base as context and orders it after the base", () => {
    const result = stackContext([onPr("b", B), onPr("a", A)], { [B]: A });

    expect(result).toEqual([
      { item: onPr("a", A), context: [] },
      { item: onPr("b", B), context: [A] },
    ]);
  });

  it("lists a chain of bases nearest first and orders down the chain", () => {
    const result = stackContext([onPr("c", C), onPr("b", B), onPr("a", A)], { [C]: B, [B]: A });

    expect(result.map((each) => [each.item.id, each.context])).toEqual([
      ["a", []],
      ["b", [A]],
      ["c", [B, A]],
    ]);
  });

  it("keeps the input order of items no stack relates", () => {
    const result = stackContext([onPr("x", C), onPr("b", B), onPr("y", C), onPr("a", A)], { [B]: A });

    expect(result.map((each) => each.item.id)).toEqual(["x", "y", "a", "b"]);
  });

  it("matches stack refs case-insensitively", () => {
    const result = stackContext([onPr("b", B)], { "Org-A/Repo-1#2": "ORG-A/repo-1#1" });

    expect(result[0]?.context).toEqual([A]);
  });

  it("survives a cycle in stacks", () => {
    const result = stackContext([onPr("b", B), onPr("a", A)], { [A]: B, [B]: A });

    expect(result.map((each) => [each.item.id, each.context])).toEqual([
      ["b", [A]],
      ["a", [B]],
    ]);
  });
});
