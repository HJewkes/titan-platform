import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAnswer, rankCards, renderDeposit, runDaily, type DailyCard, type DailyDeps, type ConsoleRunner } from "./daily.js";
import { tempTree, type TempTree } from "./fixtures.test-helpers.js";

const card = (id: string, o: Partial<DailyCard> = {}): DailyCard => ({
  id,
  title: `Talk ${id}`,
  sourceName: "Conf Talks",
  durationMinutes: 19,
  actionable: 4,
  novelty: 3,
  evidence: 4,
  total: 11,
  summary: "Synthetic summary.",
  techniques: [{ ts: "[1:05]", what: "Synthetic technique" }],
  prompt_sha: "p",
  model: "model-a",
  transcriptPath: `/data/${id}.md`,
  inputSha: "i",
  ...o,
});

const A = card("aaaaaaaaaa1");
const B = card("bbbbbbbbbb2", { total: 13, actionable: 5, evidence: 5, digestPath: "/data/bbbbbbbbbb2.digest.md", techniques: [] });
const C = card("cccccccccc3", { total: 11, actionable: 3, evidence: 4 });
const D = card("dddddddddd4", { total: 9, actionable: 2 });
const E = card("eeeeeeeeee5", { total: 12, evidence: 3, digestPath: "/data/eeeeeeeeee5.digest.md" });

describe("rankCards", () => {
  it("orders by total, then actionable, then evidence, then id", () => {
    expect(rankCards([D, C, A, E, B]).map((c) => c.id)).toEqual(["bbbbbbbbbb2", "eeeeeeeeee5", "aaaaaaaaaa1", "cccccccccc3", "dddddddddd4"]);
  });
});

describe("renderDeposit", () => {
  const stats = { failed: 1, spendUsd: 0.614 };
  const deposit = renderDeposit("2026-10-30", [A, B, C, D, E], stats);

  it("matches the golden deposit", () => {
    expect(deposit).toEqual({
      depositId: "yt-scout-2026-10-30",
      asker: "yt-scout",
      kind: "know",
      door: "two-way",
      summary: "AI video scout 10-30: 3 picks of 5 new (2 digested)",
      context: [
        "1. Talk bbbbbbbbbb2 (Conf Talks, 19 min, 13/15) – Synthetic summary.",
        "   https://youtu.be/bbbbbbbbbb2  digest: /data/bbbbbbbbbb2.digest.md",
        "2. Talk eeeeeeeeee5 (Conf Talks, 19 min, 12/15) – Synthetic summary. Synthetic technique",
        "   https://youtu.be/eeeeeeeeee5?t=65  digest: /data/eeeeeeeeee5.digest.md",
        "3. Talk aaaaaaaaaa1 (Conf Talks, 19 min, 11/15) – Synthetic summary. Synthetic technique",
        "   https://youtu.be/aaaaaaaaaa1?t=65",
        "",
        "Also scored: 2. Failed: 1. Spend: $0.61.",
        "Reply 'over <id>', 'under <id>', 'miss <id>' or 'bad-why <id>' to file an eval case.",
      ].join("\n"),
      unblocksNow: "your read of today's AI video picks; reply 'over <id>' to file an eval case",
      keys: ["yt-scout-daily", "yt-scout-daily-2026-10-30"],
    });
  });

  it("keeps unblocksNow within the console's 200 characters", () => {
    expect((deposit.unblocksNow as string).length).toBeLessThanOrEqual(200);
  });

  it("adds a digested card that ranks below the top three", () => {
    const low = card("llllllllll9", { total: 8, digestPath: "/data/low.digest.md" });
    const out = renderDeposit("2026-10-30", [A, B, C, E, low], stats);
    expect(out.summary).toBe("AI video scout 10-30: 4 picks of 5 new (3 digested)");
  });
});

describe("parseAnswer", () => {
  it("reads one verdict per line and ignores prose", () => {
    expect(parseAnswer("thanks!\nover abc123def45\nBad-Why   zzz987yyy65 because\nnonsense abc123def45")).toEqual([
      { verdict: "over", id: "abc123def45" },
      { verdict: "bad-why", id: "zzz987yyy65" },
    ]);
  });
});

describe("runDaily", () => {
  let tree: TempTree;
  let calls: string[][];
  let stdin: string | undefined;
  beforeEach(() => {
    tree = tempTree();
    calls = [];
    stdin = undefined;
  });
  afterEach(() => tree.cleanup());

  const runner: ConsoleRunner = async (args, input) => {
    calls.push(args);
    if (args[1] === "file") stdin = input;
    return { code: 0, stdout: args[1] === "file" ? "item-123\n" : "", stderr: "" };
  };

  const deps = (o: Partial<DailyDeps> = {}): DailyDeps => ({
    runner,
    cards: async () => [A, B],
    findCard: async (id) => [A, B].find((c) => c.id === id),
    stats: async () => ({ failed: 0, spendUsd: 0.2 }),
    readAnswer: async () => undefined,
    casesDir: path.join(tree.root, "cases"),
    rowsDir: path.join(tree.root, "rows"),
    stateDir: path.join(tree.root, "state"),
    runId: "daily-test",
    workflowVersion: "dev",
    now: () => new Date("2026-10-30T07:00:00Z"),
    ...o,
  });

  it("files nothing when no card is new", async () => {
    const out = await runDaily(deps({ cards: async () => [] }));
    expect(out).toEqual({ outcome: "skip" });
    expect(calls).toEqual([]);
    const rows = readFileSync(path.join(tree.root, "rows", "steps-2026-10.jsonl"), "utf8");
    expect(JSON.parse(rows)).toMatchObject({ step: "daily", outcome: "skip" });
  });

  it("withdraws yesterday's item before it files today's", async () => {
    await runDaily(deps());
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["inbox withdraw-matching", "inbox file"]);
    expect(calls[0]).toEqual(["inbox", "withdraw-matching", "--as", "yt-scout", "--actor", "yt-scout", "--key", "yt-scout-daily", "--reason", "obsolete"]);
    expect(calls[1]).toEqual(["inbox", "file", "-"]);
    expect(JSON.parse(stdin!).depositId).toBe("yt-scout-2026-10-30");
  });

  it("files nothing on a second run the same day", async () => {
    await runDaily(deps());
    calls.length = 0;
    const out = await runDaily(deps());
    expect(out).toEqual({ outcome: "skip", reason: "already-filed", itemId: "item-123" });
    expect(calls).toEqual([]);
  });

  it("stops before filing when the withdraw fails", async () => {
    const failing: ConsoleRunner = async (args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "boom" };
    };
    await expect(runDaily(deps({ runner: failing }))).rejects.toThrow(/withdraw-matching/);
    expect(calls).toHaveLength(1);
  });

  it("turns the owner's answer 'over abc123def45' into a score case", async () => {
    const known = card("abc123def45");
    const asked: string[] = [];
    await runDaily(
      deps({
        cards: async () => [A],
        findCard: async (id) => (id === known.id ? known : undefined),
        readAnswer: async (depositId) => {
          asked.push(depositId);
          return "over abc123def45";
        },
      }),
    );
    expect(asked).toEqual(["yt-scout-2026-10-29"]);
    expect(readdirSync(path.join(tree.root, "cases"))).toEqual(["score-abc123def45.json"]);
    const written = JSON.parse(readFileSync(path.join(tree.root, "cases", "score-abc123def45.json"), "utf8"));
    expect(written).toMatchObject({ step: "score", video_id: "abc123def45", label: "over", inputs: { transcript_path: "/data/abc123def45.md", transcript_sha256: "i" } });
    expect(written.output).toMatchObject({ total: 11 });
  });

  it("writes no case for an id the scout has no card for", async () => {
    await runDaily(deps({ readAnswer: async () => "over zzzzzzzzzz9" }));
    expect(() => readdirSync(path.join(tree.root, "cases"))).toThrow();
  });
});
