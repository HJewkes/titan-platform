import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceCardLoaders } from "./daily-sources.js";
import { tempTree, VALID_WATCHLIST, type TempTree } from "./fixtures.test-helpers.js";
import { scoreVideo } from "./score.js";
import type { ScoreRunner } from "./seams.js";
import { parseWatchlist } from "./watchlist.js";

const TRANSCRIPT = `---\nid: "abc123def45"\ntitle: "Synthetic Talk"\n---\n\n[1:05] A synthetic technique.\n`;

const CARD = {
  actionable: 4,
  novelty: 3,
  evidence: 4,
  pain_points: ["evals"],
  summary: "A synthetic talk.",
  techniques: [{ ts: "1:05", what: "Synthetic technique." }],
  caveat: "",
};

const runner: ScoreRunner = async (call) => ({ ok: true, value: { output: CARD, costUsd: 0.03, inputTokens: 10, outputTokens: 5, model: call.model } });

describe("sourceCardLoaders", () => {
  let tree: TempTree;
  beforeEach(() => {
    tree = tempTree();
  });
  afterEach(() => tree.cleanup());

  async function scoreInto(transcriptRel: string, cardRel: string) {
    tree.write(transcriptRel, TRANSCRIPT);
    const deps = {
      runner,
      rubric: "## The owner's system\n\nBaseline.\n\n## Scores\n\n- actionable: 0 to 5\n",
      model: "model-a",
      rowsDir: path.join(tree.root, "rows"),
      casesDir: path.join(tree.root, "cases"),
      runId: "run-1",
      workflowVersion: "dev",
      now: () => new Date("2026-10-30T03:00:00Z"),
    };
    const input = { id: "abc123def45", source: "confTalks", title: "Synthetic Talk", transcriptPath: path.join(tree.root, transcriptRel), outputPath: path.join(tree.root, cardRel) };
    await scoreVideo(deps, input);
    const watchlist = parseWatchlist(VALID_WATCHLIST, "watchlist.yml");
    return sourceCardLoaders(deps.rowsDir, watchlist, () => undefined, () => new Date("2026-10-30T07:00:00Z"));
  }

  it("carries the transcript the score step read, not one guessed from the card's name", async () => {
    const loaders = await scoreInto("out/confTalks/2026-10-29-synthetic-talk.md", "cards/abc123def45.score.json");

    const found = await loaders.findCard("abc123def45");

    expect(found?.transcriptPath).toBe(path.join(tree.root, "out/confTalks/2026-10-29-synthetic-talk.md"));
    expect(found).toMatchObject({ sourceName: "Conference Talks", total: 11, durationMinutes: null });
  });

  it("finds the digest beside the transcript when the card lives elsewhere", async () => {
    tree.write("out/confTalks/abc123def45.digest.md", "synthetic digest\n");
    const loaders = await scoreInto("out/confTalks/talk.md", "cards/abc123def45.score.json");

    const [only] = await loaders.cards();

    expect(only?.digestPath).toBe(path.join(tree.root, "out/confTalks/abc123def45.digest.md"));
  });
});
