import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuilderRef } from "../build/beat-worker.js";
import type { LayerCheckInput, LayerTextCheck } from "../build/layer-text.js";
import { buildPage } from "../composition/page.test-helpers.js";
import { chromiumQaEngine } from "../qa/qa-engine.js";
import { chromiumLayerTextCheck } from "./layer-text-check.js";

/**
 * The replay corpus: one synthetic layer per pattern qa has refused after the layer check passed it, or has since
 * excused, each with the kinds qa held. The check must flag exactly those kinds, so a rule it misses fails here and
 * not after a render. A new refusal joins the corpus as a file.
 */
const CORPUS_DIR = fileURLToPath(new URL("../../fixtures/layer-qa-corpus", import.meta.url));
const BROWSER_TIMEOUT_MS = 240_000;
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const NO_USAGE = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };

interface CorpusCase {
  file: string;
  pattern: string;
  /** The kinds qa held on the layer's render; empty for a layer qa passes. */
  qa: string[];
  elements: string[];
  packet: LayerCheckInput["packet"];
  /** The layer's source, one line per entry. */
  module: string[];
}

const CORPUS: CorpusCase[] = readdirSync(CORPUS_DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(path.join(CORPUS_DIR, file), "utf8")) as Omit<CorpusCase, "file">) }));

let pageDir: string;
let check: LayerTextCheck;
let browser: Browser;

beforeAll(async () => {
  pageDir = await buildPage();
  browser = await launch();
  check = chromiumLayerTextCheck({ page: async () => ({ dir: pageDir, sha: "test" }), engine: chromiumQaEngine(undefined, browser) });
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  rmSync(pageDir, { recursive: true, force: true });
});

const checkCase = ({ packet, module, elements }: CorpusCase) =>
  check({ builder: BUILDER, layer: { beatId: packet.beat_id, key: "k".repeat(64), build: { module: module.join("\n"), anchors: ["A1:F6"], elements, usage: NO_USAGE } }, packet });

describe("the layer check replays every custom layer qa has judged", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("holds at least one refused layer and one qa passes", () => {
    expect(CORPUS.some(({ qa }) => qa.length > 0) && CORPUS.some(({ qa }) => qa.length === 0)).toBe(true);
  });

  // catches: a layer check that passes a pattern qa refuses after render, the loop TP-4537, TP-4596, TP-4606, TP-4611 and TP-4617 each closed one rule of
  it.each(CORPUS)("flags $file with the kinds qa held: $pattern", async (corpusCase) => {
    // Arrange
    const expected = [...corpusCase.qa].sort();

    // Act
    const rows = await checkCase(corpusCase);

    // Assert
    expect([...new Set(rows.map((row) => row.rule))].sort()).toEqual(expected);
  });
});
