import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FontLoadError, launch } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuilderRef } from "../build/beat-worker.js";
import type { LayerTextCheck } from "../build/layer-text.js";
import { buildPage } from "../composition/page.test-helpers.js";
import { chromiumQaEngine } from "../qa/qa-engine.js";
import { chromiumLayerTextCheck } from "./layer-text-check.js";

// Synthetic: hand-written layers for an invented parcel desk; no builder wrote them. Each spans the frame width, so qa's content-fill gate passes.
const BROWSER_TIMEOUT_MS = 240_000;
const BUILDER: BuilderRef = { id: "claude-print", version: "1", model: "fake-model", basePromptSha: "a".repeat(64) };
const PACKET = { beat_id: "b-desk", spoken: "Twelve parcels wait at the desk.", cues: [], planned_s: 3, band: "story" as const };

const layer = (body: string) => `import { useBeatTime } from "@titan-design/react-ui/motion";

export default function Desk() {
  ${body}
}
`;

/** Sized for a 14 px caption: the page raises it to the floor, so qa reads no small text. */
const SMALL_CAPTION = layer(`const { t } = useBeatTime();
  return <div style={{ position: "absolute", left: 120, right: 120, top: 80 }}>
    <div id="count" style={{ fontSize: 96 }}>{Math.round(Math.min(t, 1) * 12)}</div>
    <div style={{ fontSize: 14 }}>parcels at the desk</div>
  </div>;`);
/** Arithmetic on the clock object itself, so the count reads NaN. */
const NAN_COUNT = layer(`const t = useBeatTime() as unknown as number;
  return <div id="count" style={{ position: "absolute", left: 120, right: 120, top: 80, fontSize: 96 }}>{Math.round(t * 12)} parcels</div>;`);
/** A line placed past the bottom of the stage box, where the source band sits. */
const PAST_THE_BOX = layer(`useBeatTime();
  return <div id="footer" style={{ position: "absolute", left: 120, right: 120, bottom: -120, fontSize: 48 }}>last scan at the desk</div>;`);

/** A 56 px count on a filled bar, in the colours `text` on `fill`. */
const onBar = (text: string, fill: string) => layer(`useBeatTime();
  return <div style={{ position: "absolute", left: 120, right: 120, top: 80, padding: 24, background: "${fill}" }}>
    <div id="count" style={{ fontSize: 56, color: "${text}" }}>12</div>
  </div>;`);

/** A fixed 140 px panel whose 48 px label, in a 360 px chip, wraps to more lines than the panel's height holds. */
const FIXED_PANEL = layer(`useBeatTime();
  return <div id="shelf" style={{ position: "absolute", left: 120, right: 120, top: 80, height: 140, padding: 40, boxSizing: "border-box",
    border: "3px solid var(--color-border-prominent)", fontSize: 48 }}>
    <div style={{ width: 360, fontWeight: 700 }}>Twelve parcels waiting</div>
  </div>;`);

/** Shows its count when the cue word "desk" is spoken, read through useCue; the page must declare the cue. */
const cueTimed = (shown: string) => `import { useBeatTime, useCue } from "@titan-design/react-ui/motion";

export default function Desk() {
  const { t } = useBeatTime();
  const at = useCue("desk");
  return <div id="count" style={{ position: "absolute", left: 120, right: 120, top: 80, fontSize: 96, opacity: t >= at ? 1 : 0 }}>${shown}</div>;
}
`;
/** "desk" is spoken early, so the stage is not still empty a third of the way in, which qa holds as late-fill. */
const CUED_PACKET = { ...PACKET, spoken: "The desk holds twelve parcels.", cues: [{ action: "V6" as const, target: "count", atCue: "desk" }] };

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

const checkCued = (module: string) =>
  check({ builder: BUILDER, layer: { beatId: PACKET.beat_id, key: "k".repeat(64), build: { module, anchors: ["A1:F6"], elements: ["count"], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } } }, packet: CUED_PACKET });

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

  // catches: a build check that holds a layer to only some of qa's held kinds, so qa refuses the panel after render (TP-4606)
  it("flags a fixed-height panel its wrapped label runs past with qa's content-overflow rule", async () => {
    // Arrange
    const module = FIXED_PANEL;

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows.map((row) => [row.rule, row.text])).toEqual([["content-overflow", "Twelve parcels waiting"]]);
  });

  it("draws a layer timed by useCue on the custom beat's own cue words", async () => {
    const rows = await checkCued(cueTimed("12 parcels"));

    expect(rows).toEqual([]);
  });

  it("flags a settled number the narration never says with the unspoken-fact rule", async () => {
    const rows = await checkCued(cueTimed("12 parcels, 3 held"));

    expect(rows).toEqual([expect.objectContaining({ beat: "b-desk", rule: "unspoken-fact", text: "12 parcels, 3 held", fact: "3" })]);
  });

  it("flags white text on an amber bar under 3:1 with its ratio and both colours", async () => {
    // Arrange
    const module = onBar("#ffffff", "#f5a524");

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows).toEqual([expect.objectContaining({ rule: "low-contrast", text: "12", contrast: { ratio: 2.04, need: 3, colour: "#ffffff", ground: "#f5a524" } })]);
  });

  it("raises no row for the theme's on-accent text on its accent fill, so the layer is not rebuilt", async () => {
    // Arrange
    const module = onBar("var(--color-on-brand-primary)", "var(--color-brand-primary-solid)");

    // Act
    const rows = await checkLayer(module);

    // Assert
    expect(rows).toEqual([]);
  });

  // Mutation: the page's CSS names a font by a network or absolute URL.
  it("names every font face by a file in the built page or inline data, never a network or cwd path", () => {
    const assets = path.join(pageDir, "assets");
    const urls = readdirSync(assets).filter((f) => f.endsWith(".css")).flatMap((f) => [...readFileSync(path.join(assets, f), "utf8").matchAll(/@font-face\{[^}]*?url\(([^)]+)\)/g)].map((m) => m[1]!));

    expect(urls.length).toBeGreaterThan(0);
    const files = urls.filter((url) => !url.startsWith("data:font/"));
    expect(files.filter((url) => !/^\.\/[\w.-]+\.woff2$/.test(url))).toEqual([]);
    expect(files.filter((url) => !readdirSync(assets).includes(url.slice(2)))).toEqual([]);
  });

  // Mutation: the check swallows the font error, or drops the URL from it.
  it("fails as an infra error naming the face and the URL when a font file is missing from the page", async () => {
    // A copy, not a second build: each in-process vite build spins up rolldown's CPU-wide thread pools.
    const broken = mkdtempSync(path.join(tmpdir(), "explainer-broken-page-"));
    cpSync(pageDir, broken, { recursive: true });
    const [woff2] = readdirSync(path.join(broken, "assets")).filter((f) => f.endsWith(".woff2"));
    rmSync(path.join(broken, "assets", woff2!));
    const brokenCheck = chromiumLayerTextCheck({ page: async () => ({ dir: broken, sha: "broken" }), engine: chromiumQaEngine(undefined, browser) });

    const failure = await brokenCheck({ builder: BUILDER, layer: { beatId: PACKET.beat_id, key: "k".repeat(64), build: { module: SMALL_CAPTION, anchors: ["A1:F6"], elements: [], usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } } }, packet: PACKET }).then(() => undefined, (e: unknown) => e);

    rmSync(broken, { recursive: true, force: true });
    if (!(failure instanceof FontLoadError)) throw new Error(`expected a FontLoadError, got ${String(failure)}`);
    expect(failure.urls).toEqual([expect.stringContaining(`/page/assets/${woff2}`)]);
  });
});
