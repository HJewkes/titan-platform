import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { launch } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildPage, fixtureDurationS, renderFrames, servePage, type PageServer } from "./page.test-helpers.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** This file reads no timeline from the held /slow/ route. */
const SLOW_TIMELINE_MS = 0;

let pageDir: string;
let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, SLOW_TIMELINE_MS);
  browser = await launch();
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

describe("a dense bar chart", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: keep the 64 px row past nine rows; twelve rows then run past the stage box and the page fails.
  test("twelve rows fit the stage box with and without a legend, as do ten rows and nine with a legend", async () => {
    const render = await renderFrames(server.url("index.html", "/timelines/dense-bar.timeline.json"), browser);

    assert.equal(render.pageDurationS, fixtureDurationS("dense-bar.timeline.json"));
  });
});
