import { rmSync } from "node:fs";
import { launch } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuilderRef } from "../build/beat-worker.js";
import type { LayerTextCheck } from "../build/layer-text.js";
import { buildPage } from "../composition/page.test-helpers.js";
import { chromiumQaEngine } from "../qa/qa-engine.js";
import { chromiumLayerTextCheck } from "./layer-text-check.js";

// Synthetic: hand-written layers for an invented parcel desk; no builder wrote them. Each spans the frame width.
const BROWSER_TIMEOUT_MS = 240_000;
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const cue = (atCue: string) => ({ action: "V6" as const, target: "desk", atCue });
/** "parcels" reveals the desk card; "full" names it again once it is shown. */
const PACKET = { beat_id: "b-desk", spoken: "Twelve parcels wait at the desk, and the desk is full.", cues: [cue("parcels"), cue("full")], planned_s: 8 };

/** The desk card opens by clip-path on "parcels"; `onFull` is its style once "full" is spoken. Two runs, so qa sees no late-fill. */
const deskLayer = (onFull: string) => `import { useBeatTime, useCue } from "@titan-design/react-ui/motion";

export default function Desk() {
  const { t } = useBeatTime();
  const shown = useCue("parcels");
  const full = useCue("full");
  const open = Math.max(0, Math.min(1, (t - shown) / 0.4));
  const lit = t >= full && t < full + 0.8;
  return <div id="desk" style={{
    position: "absolute", left: 120, right: 120, top: 80, height: 200, fontSize: 72,
    display: "flex", alignItems: "center", padding: "0 40px", boxSizing: "border-box",
    color: "var(--color-text-primary)", background: "var(--color-background-subtle)",
    clipPath: \`inset(0 \${100 - open * 100}% 0 0)\`,
    ...(${onFull}),
  }}><span>Desk</span><span style={{ marginLeft: 48 }}>12 parcels</span></div>;
}
`;
/** The repeat cue draws an outline outside the card's own clip-path, which cuts it away. */
const CLIPPED_OUTLINE = deskLayer(`t >= full ? { outline: "10px solid var(--color-border-prominent)", outlineOffset: 6 } : {}`);
/** The repeat cue lights the card at full colour inside its box for 0.8 s, then it returns to rest. */
const LIT_PULSE = deskLayer(`lit ? { background: "var(--color-brand-primary-solid)", color: "var(--color-on-brand-primary)" } : {}`);

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
  check({ builder: BUILDER, layer: { beatId: PACKET.beat_id, key: "k".repeat(64), build: { module, anchors: ["A1:F6"], elements: ["desk"], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } } }, packet: PACKET });

describe("the rendered cue check on one custom layer", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("flags a repeat cue whose outline the element's own clip-path cuts away with the still-cue rule", async () => {
    // Arrange
    const module = CLIPPED_OUTLINE;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows).toEqual([expect.objectContaining({ beat: "b-desk", element: "desk", rule: "still-cue", text: "full" })]);
  });

  it("passes a repeat cue that lights the shown card at full colour and lets it return to rest", async () => {
    // Arrange
    const module = LIT_PULSE;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows).toEqual([]);
  });
});
