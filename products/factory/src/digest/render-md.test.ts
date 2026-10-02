import { describe, expect, it } from "vitest";
import { emptyModel } from "../test-support/digest.js";
import type { Ask } from "./model.js";
import { rankDigest } from "./rank.js";
import { FULL_COMMAND, renderMarkdown, WORD_LIMIT, wordCount } from "./render-md.js";

const LONG = "a long synthetic sentence that keeps going well past any sensible clip so the cap decides";

function maximalModel(asks: number) {
  const needsYou: Ask[] = Array.from({ length: asks }, (_, i) => ({ text: `ask ${i} ${LONG}`, command: `tool act --id ${i}`, source: "seat-a", keys: [`pr:widgets#${i}`] }));
  const merged = Array.from({ length: 40 }, (_, i) => ({ ref: `acme/widgets#${100 + i}`, title: `merged change number ${i} with a title of several words`, at: `2026-03-10T12:${String(i).padStart(2, "0")}:00Z` }));
  const stuck = Array.from({ length: 12 }, (_, i) => ({ ref: `acme/widgets#${200 + i}`, reason: `stuck ${LONG}`, since: "2026-03-10T08:00:00Z" }));
  const seats = [{ seat: "seat-a", dispatches: 9, usd: 12.5 }, { seat: "seat-b", dispatches: 3, usd: 2 }];
  const spend = [{ pool: "pool-a", sevenDay: 70, fiveHour: 12, stale: false }, { pool: "pool-b", sevenDay: 30, stale: true }];
  return emptyModel({ needsYou, merged, stuck, seats, spend, gaps: ["agent-chat digest: exit 1"] });
}

describe("renderMarkdown", () => {
  it("keeps a maximal digest within the word limit and ends with the overflow line", () => {
    const markdown = renderMarkdown(rankDigest(maximalModel(9)));

    expect(wordCount(markdown)).toBeLessThanOrEqual(WORD_LIMIT);
    expect(markdown.trimEnd().split("\n").at(-1)).toBe(`and 42 more: \`${FULL_COMMAND}\``);
  });

  it("stays within the word limit when a seat queue holds 30 asks", () => {
    expect(wordCount(renderMarkdown(rankDigest(maximalModel(30))))).toBeLessThanOrEqual(WORD_LIMIT);
  });

  it("opens with the deterministic headline and names the busiest fresh pool", () => {
    const lines = renderMarkdown(rankDigest(maximalModel(9))).split("\n");

    expect(lines.slice(0, 3)).toEqual(["# Owner digest 2026-03-10 12:00", "", "9 need you, 40 merged, 12 stuck, pool-a pool 70% of week"]);
  });

  it("says each section is empty rather than dropping it", () => {
    const markdown = renderMarkdown(rankDigest(emptyModel()));

    expect(markdown).toContain("## Needs you (0)\nNothing.");
    expect(markdown).toContain("## Stuck (0)\nNothing stuck.");
    expect(markdown).not.toContain("more:");
  });
});
