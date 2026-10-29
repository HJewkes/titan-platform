import { describe, expect, it } from "vitest";
import { PrefixLintError, stablePrefix, type PrefixSection } from "./stable-prefix.js";

const sections = (who: string): PrefixSection[] => [
  { name: "rules", text: "Follow the brief literally." },
  { name: "identity", text: `You are ${who}.` },
];

describe("stablePrefix", () => {
  it("refuses two lists that differ only in the agent name", () => {
    expect(() => stablePrefix(sections("worker-a"), { agentName: "worker-a" })).toThrow(
      PrefixLintError,
    );
    expect(() => stablePrefix(sections("worker-b"), { agentName: "worker-b" })).toThrow(
      /agent name/,
    );
  });

  it("returns an identical hash for identical input across calls", () => {
    const first = stablePrefix(sections("a worker"));
    const second = stablePrefix(sections("a worker"));
    expect(second).toEqual(first);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the section order it is given", () => {
    const forward = stablePrefix(sections("a worker"));
    const reversed = stablePrefix([...sections("a worker")].reverse());
    expect(forward.text.indexOf("## rules")).toBeLessThan(forward.text.indexOf("## identity"));
    expect(reversed.text.indexOf("## identity")).toBeLessThan(reversed.text.indexOf("## rules"));
    expect(reversed.hash).not.toBe(forward.hash);
  });

  it.each([
    ["worktree path", "see /repo/.worktrees/x/src"],
    ["ISO date", "as of 2026-10-28"],
    ["40-hex sha", `head ${"a1b2c3d4e5".repeat(4)}`],
    ["<spawner> fill-in", "report to <spawner>"],
  ])("refuses a %s in any section", (rule, text) => {
    expect(() => stablePrefix([{ name: "s", text }])).toThrow(rule);
  });

  it("accepts text with a short hex word and no per-spawn values", () => {
    expect(() => stablePrefix([{ name: "s", text: "commit deadbeef is short" }])).not.toThrow();
  });
});
