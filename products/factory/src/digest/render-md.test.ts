import { describe, expect, it } from "vitest";
import { emptyModel } from "../test-support/digest.js";
import type { Ask, DecidedLine } from "./model.js";
import { NO_CAPS, rankDigest } from "./rank.js";
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

  it("renders a gate ask on one line with its evidence, resolve command and waiting since", () => {
    const ask: Ask = { text: "acme/widgets#4 approve-merge: Merge it", evidence: "https://ci.example/run/4", command: "titan-factory gate resolve r approve-merge", since: "2026-03-10T08:00:00Z", source: "factory", keys: ["gate:g-4"] };

    const markdown = renderMarkdown(rankDigest(emptyModel({ needsYou: [ask] })));

    expect(markdown).toContain(
      "1. acme/widgets#4 approve-merge: Merge it | evidence: https://ci.example/run/4 | `titan-factory gate resolve r approve-merge` | waiting since 2026-03-10T08:00:00Z (factory)",
    );
  });
});

const awaiting: DecidedLine = {
  questionId: "q-1",
  question: "Rebase or merge main into the branch?",
  answer: "rebase",
  class: "tech_design",
  state: "awaiting audit",
  reversible: "force-push the old head",
  confidence: 0.82,
  principleIds: ["p1", "p2"],
  overrule: 'agent-chat answer q-1 "..."',
};
const overruled: DecidedLine = { questionId: "q-2", question: "Retry the flaky job?", answer: "yes", class: "agent_ops", state: "overruled" };

const decisions = (n: number): DecidedLine[] =>
  Array.from({ length: n }, (_, i) => ({ ...awaiting, questionId: `q-${i}`, question: `question ${i} ${LONG}`, overrule: `agent-chat answer q-${i} "..."` }));

describe("Decided for you", () => {
  it("lists each decision after Needs you, with the overrule command only while it awaits audit, then the reversal rate", () => {
    const reversals = [{ class: "agent_ops", decided: 4, overruled: 1 }, { class: "tech_design", decided: 2, overruled: 0 }];

    const markdown = renderMarkdown(rankDigest(emptyModel({ decided: [awaiting, overruled], reversals })));

    expect(markdown).toContain(
      [
        "## Needs you (0)",
        "Nothing.",
        "",
        "## Decided for you (2)",
        '1. Rebase or merge main into the branch? -> rebase [tech_design, conf 0.82, principles p1,p2] | reversible: force-push the old head | overrule: `agent-chat answer q-1 "..."`',
        "2. Retry the flaky job? -> yes [agent_ops] | overruled",
        "Reversal rate, last 7 days: agent_ops 1/4 (25%), tech_design 0/2 (0%)",
        "",
        "## Merged (0)",
      ].join("\n"),
    );
    expect(markdown).not.toContain("agent-chat answer q-2");
  });

  it("is left out when nothing was decided", () => {
    expect(renderMarkdown(rankDigest(emptyModel()))).not.toContain("Decided for you");
  });

  it("caps the decisions shown and counts the rest in the overflow line", () => {
    const markdown = renderMarkdown(rankDigest(emptyModel({ decided: decisions(30) })));

    expect(markdown).toContain("## Decided for you (30)");
    expect(markdown).toContain("agent-chat answer q-4 ");
    expect(markdown).not.toContain("agent-chat answer q-5 ");
    expect(markdown.trimEnd().split("\n").at(-1)).toBe(`and 25 more: \`${FULL_COMMAND}\``);
  });

  it("shows only the decisions the word limit leaves room for once the asks are shown", () => {
    const markdown = renderMarkdown(rankDigest({ ...maximalModel(9), decided: decisions(30) }));

    expect(wordCount(markdown)).toBeLessThanOrEqual(WORD_LIMIT);
    expect(markdown).not.toContain("Decided for you");
    expect(markdown.trimEnd().split("\n").at(-1)).toBe(`and 72 more: \`${FULL_COMMAND}\``);
  });

  it("shows every decision in the full digest", () => {
    const markdown = renderMarkdown(rankDigest({ ...maximalModel(9), decided: decisions(30) }, NO_CAPS));

    expect(markdown).toContain("agent-chat answer q-29 ");
    expect(markdown).not.toContain("more:");
  });
});
