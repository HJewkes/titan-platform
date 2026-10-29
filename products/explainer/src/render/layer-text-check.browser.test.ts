import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuilderRef } from "../build/beat-worker.js";
import type { LayerTextCheck } from "../build/layer-text.js";
import { buildPage } from "../composition/page.test-helpers.js";
import { chromiumLayerTextCheck } from "./layer-text-check.js";

// Synthetic: hand-written layers for an invented parcel desk; no builder wrote them.
const BROWSER_TIMEOUT_MS = 240_000;
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const PACKET = { beat_id: "b-desk", spoken: "Twelve parcels wait at the desk.", cues: [], planned_s: 3 };

const layer = (body: string) => `import { useBeatTime } from "@titan-design/react-ui/motion";

export default function Desk() {
  ${body}
}
`;

/** Sized for a 14 px caption: the page raises it to the floor, so qa reads no small text. */
const SMALL_CAPTION = layer(`const { t } = useBeatTime();
  return <div style={{ position: "absolute", left: 120, top: 80 }}>
    <div id="count" style={{ fontSize: 96 }}>{Math.round(Math.min(t, 1) * 12)}</div>
    <div style={{ fontSize: 14 }}>parcels at the desk</div>
  </div>;`);
/** Arithmetic on the clock object itself, so the count reads NaN. */
const NAN_COUNT = layer(`const t = useBeatTime() as unknown as number;
  return <div id="count" style={{ position: "absolute", left: 120, top: 80, fontSize: 96 }}>{Math.round(t * 12)} parcels</div>;`);
/** A line placed past the bottom of the stage box, where the source band sits. */
const PAST_THE_BOX = layer(`useBeatTime();
  return <div id="footer" style={{ position: "absolute", left: 120, bottom: -120, fontSize: 48 }}>last scan at the desk</div>;`);

let pageDir: string;
let check: LayerTextCheck;

beforeAll(async () => {
  pageDir = await buildPage();
  check = chromiumLayerTextCheck({ page: async () => ({ dir: pageDir, sha: "test" }) });
}, BROWSER_TIMEOUT_MS);

afterAll(() => rmSync(pageDir, { recursive: true, force: true }));

const checkLayer = (module: string) =>
  check({ builder: BUILDER, layer: { beatId: PACKET.beat_id, key: "k".repeat(64), build: { module, anchors: ["A1:F6"], elements: [], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } } }, packet: PACKET });

describe("the rendered text check on one custom layer", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutations: CustomLayer never raises its layer's text to the floor (kills the 14 px caption case).
  it("passes a layer whose 14 px caption the page raises to the type floor", async () => {
    const rows = await checkLayer(SMALL_CAPTION);

    expect(rows).toEqual([]);
  });

  it("flags a count drawn as NaN with the bad-text rule", async () => {
    const rows = await checkLayer(NAN_COUNT);

    expect(rows).toEqual([expect.objectContaining({ beat: "b-desk", rule: "bad-text", text: "NaN" })]);
  });

  it("flags text past the stage box with qa's under-chrome rule", async () => {
    const rows = await checkLayer(PAST_THE_BOX);

    expect(rows.map((row) => [row.rule, row.text])).toEqual([["under-chrome", "last scan at the desk"]]);
  });
});
