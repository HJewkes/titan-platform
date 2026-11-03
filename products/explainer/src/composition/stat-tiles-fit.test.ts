import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildPage, servePage, STAGE, type PageServer } from "./page.test-helpers.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** The template keeps 10 % of the 1920 px frame clear on each side (--beat-content-width: 80 %). */
const SIDE_MARGIN_PX = 192;

let pageDir: string;
let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, 0);
  browser = await launch();
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

/** The served fixture page seeked to `t`, with what `read` returns from it. */
async function atMoment<T>(fixture: string, t: number, read: () => T): Promise<T> {
  const { page } = await openCapturePage(browser, server.url("index.html", `/timelines/${fixture}`), STAGE);
  try {
    await page.evaluate(async (seconds) => {
      window.__titanMotion?.seek(seconds);
      await window.__titanMotion?.ready();
    }, t);
    return await page.evaluate(read);
  } finally {
    await page.context().close();
  }
}

describe("a stat row in the stage fit", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: ignore how far the row's tiles spill; the tiles then run out to the frame edge. Remove nowrap; a prefix wraps above its number.
  test.each([
    ["three", "stat-tiles-3.timeline.json", ["$1261", "$13.41", "v1"]],
    ["four", "stat-tiles.timeline.json", ["$1261", "$13.41", "v1", "4821"]],
  ])("%s stat tiles keep the frame's side margins and draw each prefix with its number", async (_count, fixture, shown) => {
    const read = () => {
      const tiles = [...document.querySelectorAll(".beat-stat")].map((el) => el.getBoundingClientRect());
      const values = [...document.querySelectorAll(".beat-stat-value")];
      return {
        left: Math.min(...tiles.map((r) => r.left)),
        right: Math.max(...tiles.map((r) => r.right)),
        valueHeights: values.map((el) => el.getBoundingClientRect().height),
        shown: values.map((el) => el.textContent),
      };
    };

    const value = await atMoment(fixture, 2.9, read);

    assert.deepEqual(value.shown, shown);
    assert.ok(value.valueHeights.every((h) => h === value.valueHeights[0]), `a value wrapped: heights ${value.valueHeights.join(", ")}`);
    assert.ok(value.left >= SIDE_MARGIN_PX - 1, `left tile edge ${value.left} px`);
    assert.ok(STAGE.width - value.right >= SIDE_MARGIN_PX - 1, `right tile edge ${STAGE.width - value.right} px from the frame edge`);
  });
});
