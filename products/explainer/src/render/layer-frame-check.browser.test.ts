import { rmSync } from "node:fs";
import { launch } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuilderRef } from "../build/beat-worker.js";
import type { LayerTextCheck } from "../build/layer-text.js";
import { buildPage } from "../composition/page.test-helpers.js";
import { chromiumQaEngine } from "../qa/qa-engine.js";
import { chromiumLayerTextCheck } from "./layer-text-check.js";

// Synthetic: hand-written layers for an invented parcel desk; no builder wrote them.
const BROWSER_TIMEOUT_MS = 240_000;
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const PACKET = { beat_id: "b-desk", spoken: "Twelve parcels wait at the desk.", cues: [], planned_s: 3, band: "story" as const };

const layer = (body: string) => `import { useBeatTime } from "@titan-design/react-ui/motion";

export default function Desk() {
  const { t } = useBeatTime();
  ${body}
}
`;

/** One short count pinned left: its settled content spans a sliver of the frame width. */
const NARROW = layer(`return <div id="count" style={{ position: "absolute", left: 120, top: 80, fontSize: 96 }}>{t >= 0 ? "12" : ""}</div>;`);
/** Twenty-two words on screen together, across the frame width. */
const WORDY = layer(`const words = "scanner reads each label then a clerk sorts every box into bins by street and day before vans load them at dawn";
  return <div id="desk" style={{ position: "absolute", left: 120, right: 120, top: 80, fontSize: 48 }}>{t >= 0 ? words : ""}</div>;`);
/**
 * A wide card that slides past the right edge from 1.15 s to 1.75 s. qa's phase-0 sweep and the beat's 1.5 s midpoint
 * land on it once; a beat started 0.1 s later puts a sweep sample at 1.4 s beside that midpoint, and qa holds it.
 */
const SLIDES_OUT = layer(`const out = t >= 1.15 && t < 1.75;
  return <div id="card" style={{ position: "absolute", left: out ? 1600 : 120, width: 1680, top: 80, fontSize: 56 }}>parcels at the desk</div>;`);

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

const checkLayer = (module: string) =>
  check({ builder: BUILDER, layer: { beatId: PACKET.beat_id, key: "k".repeat(64), build: { module, anchors: ["A1:F6"], elements: [], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } } }, packet: PACKET });

describe("the rendered frame check on one custom layer", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("flags a layer whose settled content spans under 60 % of the frame width with qa's content-fill gate", async () => {
    // Arrange
    const module = NARROW;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows).toEqual([expect.objectContaining({ rule: "content-fill", element: "stage" })]);
  });

  it("flags a layer showing 22 words at once with qa's words-per-frame gate", async () => {
    // Arrange
    const module = WORDY;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows.map((row) => [row.rule, row.text])).toEqual([["words-per-frame", "22 words on screen"]]);
  });

  it("refuses a card off frame that qa holds only once the voiced start moves its 2 Hz sweep", async () => {
    // Arrange
    const module = SLIDES_OUT;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows.map((row) => [row.rule, row.text, row.atS])).toEqual([["off-frame", "parcels at the desk", 1.4]]);
  });
});
