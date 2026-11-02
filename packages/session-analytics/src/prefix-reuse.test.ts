import type { RequestBlock } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { firstDivergence, prefixReuse, type PrefixRow } from "./prefix-reuse.js";

const block = (path: string, text: string): RequestBlock => ({
  section: path.startsWith("tools") ? "tools" : path.startsWith("system") ? "system" : "messages",
  path,
  text,
});

const MIN = 60_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function row(overrides: Partial<PrefixRow> & { atMin?: number; prelude?: string } = {}): PrefixRow {
  const { atMin = 0, prelude = "prelude-a", ...rest } = overrides;
  return {
    sessionId: "s",
    agentName: "a",
    account: "acct",
    model: "claude-opus-5-5",
    timestamp: new Date(T0 + atMin * MIN).toISOString(),
    blocks: [block("tools", "[]"), block("system[1]", "global"), block("system[2]", prelude), block("messages[0][0]", "claude-md")],
    cacheControl: [{ path: "system[1]", type: "ephemeral", ttl: "1h", scope: "global" }],
    usage: { inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 600, cacheCreation5mTokens: 0, cacheCreation1hTokens: 600, outputTokens: 0 },
    ...rest,
  };
}

describe("firstDivergence", () => {
  it("gives the block, absolute UTF-8 byte and in-block offset of the first difference", () => {
    const a = [block("tools", "[]"), block("system[2]", "héllo A")];
    const b = [block("tools", "[]"), block("system[2]", "héllo B")];

    expect(firstDivergence(a, b)).toEqual({ path: "system[2]", absoluteByte: 2 + Buffer.byteLength("héllo "), inBlockChar: 6 });
  });

  it("names the block where one request simply ends and gives null for identical requests", () => {
    const a = [block("tools", "[]"), block("system[2]", "x")];

    expect(firstDivergence(a, [...a, block("messages[0][0]", "more")])).toEqual({ path: "messages[0][0]", absoluteByte: 3, inBlockChar: 0 });
    expect(firstDivergence(a, [...a])).toBeNull();
  });

  it("treats blocks reordered with the same text as a divergence", () => {
    const a = [block("messages[0][0]", "one"), block("messages[0][1]", "two")];
    const b = [block("messages[0][0]", "two"), block("messages[0][1]", "one")];

    expect(firstDivergence(a, b)).toMatchObject({ path: "messages[0][0]", absoluteByte: 0 });
  });
});

describe("prefixReuse hit simulation", () => {
  const hits = (gapMin: number) => prefixReuse([row({ atMin: 0 }), row({ atMin: gapMin })], { windowMin: 60 }).hit;

  it("hits at 59 minutes and misses at 61", () => {
    expect(hits(59)).toEqual({ hits: 1, total: 2, rate: 0.5 });
    expect(hits(61)).toEqual({ hits: 0, total: 2, rate: 0 });
  });

  it("misses at exactly the window", () => {
    expect(hits(60).hits).toBe(0);
  });

  it("refreshes the window on each hit and keys on account, model and system[2]", () => {
    const rows = [row({ atMin: 0 }), row({ atMin: 50 }), row({ atMin: 100 }), row({ atMin: 101, account: "other" }), row({ atMin: 102, prelude: "prelude-b" })];

    expect(prefixReuse(rows).hit).toMatchObject({ hits: 2, total: 5 });
  });
});

describe("prefixReuse", () => {
  it("reports the token-weighted and median share, the thresholds and the median first-call size", () => {
    const heavy = row({ usage: { inputTokens: 0, cacheReadTokens: 700, cacheCreationTokens: 300, cacheCreation5mTokens: 0, cacheCreation1hTokens: 300, outputTokens: 0 } });
    const light = row({ usage: { inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, outputTokens: 0 } });

    const report = prefixReuse([heavy, light, row({ usage: null })]);

    expect(report).toMatchObject({ sessions: 3, measured: 2, tokenShare: 0.35, medianShare: 0.35, medianFirstCallTokens: 1000, atLeast60: 1, atLeast70: 1 });
    expect(report.inputUsd).toBeGreaterThan(0);
  });

  it("groups pairwise first divergence by block and counts the cache breakpoint layouts", () => {
    const rows = [row({ prelude: "prelude-a" }), row({ prelude: "prelude-b" }), row({ prelude: "prelude-c", cacheControl: [] })];

    const report = prefixReuse(rows, { pairs: 6 });

    expect(report.divergence).toEqual({ pairs: 6, identical: 0, byBlock: [{ path: "system[2]", pairs: 6, medianAbsoluteByte: 2 + 6 + 8 }] });
    expect(report.cacheControl).toEqual([
      { signature: "system[1]:1h:global", sessions: 2 },
      { signature: "", sessions: 1 },
    ]);
  });
});
