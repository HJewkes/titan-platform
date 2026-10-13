import { describe, expect, it } from "vitest";
import { followUpsFields, MAX_FOLLOW_UP_TITLE_CHARS, parseFollowUps } from "./follow-ups.js";
import { reviewerBrief } from "./reviewer-brief.js";

const HEAD = "a".repeat(40);
const VERDICT = `Verdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}`;
const BLOCK = ["Follow-ups:", "-  Cache the head lookup |  A second lookup at one head reads the cache | medium", "- Name the retry bound | The bound is a named constant | low"].join("\n");
const ITEMS = [
  { title: "Cache the head lookup", doneWhen: "A second lookup at one head reads the cache", severity: "medium" },
  { title: "Name the retry bound", doneWhen: "The bound is a named constant", severity: "low" },
];

describe("parseFollowUps", () => {
  it("reads each item's trimmed title, done-when and severity in order", () => {
    expect(parseFollowUps(`Looks right.\n\n${BLOCK}\n\n${VERDICT}\n`)).toEqual({ items: ITEMS });
  });

  it("reads a block written after the verdict lines, as agent-chat's contract places it", () => {
    expect(parseFollowUps(`${VERDICT}\n\nNo blocking items.\n\n${BLOCK}\n`)).toEqual({ items: ITEMS });
  });

  it("stops at the first line that is not a bullet", () => {
    expect(parseFollowUps(`${BLOCK}\nMore prose.\n- Not an item | ignored | high\n`).items).toHaveLength(2);
  });

  it.each([
    ["no block", VERDICT],
    ["an explicit none", `Follow-ups: none\n\n${VERDICT}`],
    ["a block inside a code fence", `\`\`\`\n${BLOCK}\n\`\`\`\n${VERDICT}`],
  ])("proposes nothing and warns nothing for %s", (_scenario, text) => {
    expect(parseFollowUps(text)).toEqual({ items: [] });
  });

  it.each([
    ["bad_item", "an item with two fields", BLOCK.replace(" | low", "")],
    ["bad_item", "a heading with no items", "Follow-ups:\n\nLater."],
    ["bad_item", "a heading carrying prose", "Follow-ups: maybe cache the lookup"],
    ["bad_severity", "a critical item", BLOCK.replace("| low", "| critical")],
    ["too_many", "six items", ["Follow-ups:", ...Array.from({ length: 6 }, (_, n) => `- Task ${n} | Done ${n} | low`)].join("\n")],
    ["too_long", "a title over the bound", BLOCK.replace("Name the retry bound", "x".repeat(MAX_FOLLOW_UP_TITLE_CHARS + 1))],
    ["placeholder", "the brief's template quoted back", "Follow-ups:\n- <title> | <done_when> | <low, medium or high>"],
    ["multiple_blocks", "two headings", `${BLOCK}\n\n${BLOCK}`],
  ])("drops the whole block with %s for %s", (warning, _scenario, block) => {
    expect(parseFollowUps(`${block}\n\n${VERDICT}\n`)).toEqual({ items: [], warning });
  });

  it("finds no item in the reviewer brief itself", () => {
    const brief = reviewerBrief({ repo: "octo/demo", pr: 7, head: HEAD, checkoutRoot: "/reviews" });

    expect(parseFollowUps(brief)).toEqual({ items: [] });
  });
});

describe("followUpsFields", () => {
  it("omits both fields when the reviewer proposed nothing", () => {
    expect(followUpsFields(VERDICT)).toEqual({});
  });

  it("carries only the warning for a malformed block", () => {
    expect(followUpsFields(`Follow-ups:\n- one field\n${VERDICT}`)).toEqual({ followUpsWarning: "bad_item" });
  });
});
