import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPage, STAGE } from "../composition/page.test-helpers.js";
import type { Timeline } from "../composition/timeline.js";
import { buildOccupancy, CUSTOM_LAYER_ELEMENT } from "../occupancy-table.js";
import { layerLayouts } from "../qa/qa-measured.js";
import { timelineFromArtifact } from "../qa/qa-timeline.js";
import { servePage } from "./composition-page.js";
import { SYNTHETIC_ELEMENT, writeSyntheticTree } from "./custom-layer-fixture.test-helpers.js";
import { stageCustomLayers, withCustomLayers } from "./custom-layers.js";

const BROWSER_TIMEOUT_MS = 240_000;
const BEAT = { id: "beat-01", kind: "held", startS: 1, durationS: 3, slots: {} };

let scratch: string;
let pageDir: string;
let staged: Timeline;

beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "explainer-custom-layers-"));
  pageDir = await buildPage();
  const tree = writeSyntheticTree(path.join(scratch, "tree"), "b-hold");
  const layers = await stageCustomLayers(tree, new Map([["b-hold", BEAT.id]]), pageDir);
  staged = withCustomLayers({ durationS: 4, beats: [BEAT] }, layers);
}, BROWSER_TIMEOUT_MS);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(pageDir, { recursive: true, force: true });
});

interface Seen {
  errors: string[];
  box?: { x: number; y: number; width: number; height: number };
  text?: string;
}

/** The page on `timeline`, seeked to `t` and read once `ready()` resolves, as the capture reads each frame. */
async function seenAt(timeline: Timeline, t: number): Promise<Seen> {
  const file = path.join(mkdtempSync(path.join(scratch, "run-")), "timeline.json");
  writeFileSync(file, JSON.stringify(timeline));
  const served = await servePage(pageDir, file);
  const browser = await launch();
  try {
    const { page } = await openCapturePage(browser, served.url, STAGE);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const drawn = await page.evaluate(async ({ seconds, id }) => {
      window.__titanMotion?.seek(seconds);
      await window.__titanMotion?.ready();
      const el = document.getElementById(id);
      if (!el) return undefined;
      const { x, y, width, height } = el.getBoundingClientRect();
      return { box: { x, y, width, height }, text: el.textContent };
    }, { seconds: t, id: SYNTHETIC_ELEMENT });
    // A failed import settles ready() before its error reaches the page; one more turn lets it land.
    await page.waitForTimeout(200);
    return { errors, ...drawn };
  } finally {
    await browser.close();
    await served.close();
  }
}

describe("a custom layer on the composition page", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutations: the layer is not bundled into the page tree; the page imports it outside ready() (no useWaitUntil),
  // so the frame is read before the layer commits; Composition draws a custom beat through its kind's view.
  it("renders at startS + 1 with no page error, its anchors in the occupancy table", async () => {
    const t = BEAT.startS + 1;

    const seen = await seenAt(staged, t);

    expect(seen.errors).toEqual([]);
    expect(seen.text).toBe("Parcels waiting: 10");
    expect(seen.box).toEqual({ x: 320, y: 180, width: 1280, height: 720 });
    const [table] = buildOccupancy({ stage: STAGE, layouts: layerLayouts(timelineFromArtifact(staged)), marks: [{ beat: BEAT.id, t, elements: [{ id: SYNTHETIC_ELEMENT, box: seen.box! }] }] });
    expect(table).toMatchObject({ beat: BEAT.id, source: "declared" });
    expect(table!.cells.B2).toEqual([CUSTOM_LAYER_ELEMENT, SYNTHETIC_ELEMENT]);
    expect(table!.cells.E5).toEqual([CUSTOM_LAYER_ELEMENT, SYNTHETIC_ELEMENT]);
    expect(table!.cells.A1).toBeUndefined();
  });

  it("fails with a page error naming a module the page tree lacks, never a blank beat", async () => {
    const absent = { ...staged, beats: [{ ...staged.beats[0]!, module: "./custom-layers/absent.js" }] };

    const seen = await seenAt(absent, BEAT.startS + 1);

    expect(seen.errors).toEqual([expect.stringContaining("custom layer ./custom-layers/absent.js failed to load")]);
  });
});
