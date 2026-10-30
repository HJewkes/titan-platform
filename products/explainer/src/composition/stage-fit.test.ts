import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { chromiumStageFitScan } from "../render/stage-fit-scan.js";
import { buildPage, fixtureDurationS, renderFrames, servePage, STAGE, type PageServer } from "./page.test-helpers.js";
import { parseTimeline } from "./timeline.js";

const BROWSER_TIMEOUT_MS = 240_000;
const FLOOR_PX = 40;
/** The template keeps 10 % of the 1920 px frame clear on each side (--beat-content-width: 80 %). */
const SIDE_MARGIN_PX = 192;
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

let pageDir: string;
let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, 0);
  browser = await launch();
}, BROWSER_TIMEOUT_MS);

// Mutation: the stage-fit scan closes the browser it was lent; its test is the file's last, so only this check sees it.
afterEach(() => assert.ok(browser.isConnected(), "a step closed the file's browser"));

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

/** The served fixture page at `t`, in report mode when asked, with what `read` returns from it and the page errors. */
async function atMoment<T>(fixture: string, t: number, read: () => T, report = false): Promise<{ value: T; errors: string[] }> {
  const url = `${server.url("index.html", `/timelines/${fixture}`)}${report ? "&stage-fit=report" : ""}`;
  const { page } = await openCapturePage(browser, url, STAGE);
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async (seconds) => {
      window.__titanMotion?.seek(seconds);
      await window.__titanMotion?.ready();
    }, t);
    return { value: await page.evaluate(read), errors };
  } finally {
    await page.context().close();
  }
}

function smallestTextPx(): number {
  const leaves = [...document.querySelectorAll(".beat-frame *")].filter((el) => el.childElementCount === 0 && el.textContent.trim() !== "");
  return Math.min(...leaves.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
}

describe("the stage fit", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: make fitToStage return the overflow at scale 1; the four long labels then fail the page on its first frame.
  test("a stat beat whose long labels overrun the row shrinks into its stage box, every frame, no text under 40 px", async () => {
    const fixture = "stat-fit.timeline.json";

    const render = await renderFrames(server.url("index.html", `/timelines/${fixture}`), browser);
    const settled = await atMoment(fixture, 2.9, smallestTextPx);

    assert.equal(render.pageDurationS, fixtureDurationS(fixture));
    assert.deepEqual(settled.errors, []);
    assert.ok(settled.value >= FLOOR_PX, `smallest text ${settled.value} px`);
  });

  // Mutation: let a tile grow past its share of the row; the four tiles then spill into the frame's margins.
  test.each([
    ["three", "stat-tiles-3.timeline.json", ["$1261", "$13.41", "v1"]],
    ["four", "stat-tiles.timeline.json", ["$1261", "$13.41", "v1", "4821"]],
  ])("%s stat tiles keep the frame's side margins and draw each prefix with its number", async (_count, fixture, shown) => {
    const read = () => {
      const edge = (el: Element) => el.getBoundingClientRect();
      const tiles = [...document.querySelectorAll(".beat-stat")].map(edge);
      return { left: Math.min(...tiles.map((r) => r.left)), right: Math.max(...tiles.map((r) => r.right)), shown: [...document.querySelectorAll(".beat-stat-value")].map((el) => el.textContent) };
    };

    const { value } = await atMoment(fixture, 2.9, read);

    assert.deepEqual(value.shown, shown);
    assert.ok(value.left >= SIDE_MARGIN_PX - 1, `left tile edge ${value.left} px`);
    assert.ok(STAGE.width - value.right >= SIDE_MARGIN_PX - 1, `right tile edge ${STAGE.width - value.right} px from the frame edge`);
  });

  // Mutation: name a row's element by its own class alone; the row then loses which figure to shorten.
  test("a stat label too long even at the type floor is a row naming the beat, the label, the px and a shorten hint", async () => {
    const { value: row, errors } = await atMoment("stat-floor.timeline.json", 2.9, () => window.__stageOverflows?.["label-past-floor"], true);

    assert.deepEqual(errors, []);
    assert.ok(row);
    assert.equal(row.element, "figures-2 beat-stat-label");
    assert.ok(row.px > 0);
    assert.match(row.hint, /^shorten figures-2 beat-stat-label "a synthetic label far too long[^"]*" to <= \d+ chars$/);
  });

  // Mutation: throw on the first overflow in report mode too; the scan then stops at the stat beat and never sees the line.
  test("one stage-fit scan reports every beat past its stage box, in beat order", async () => {
    const fixture = "stat-floor.timeline.json";
    const timeline = parseTimeline(JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8")));

    const rows = await chromiumStageFitScan(browser)(server.url("index.html", `/timelines/${fixture}`), timeline, STAGE);

    assert.deepEqual(rows.map((row) => row.beat), ["label-past-floor", "line-past-floor"]);
    assert.ok(rows.every((row) => row.px > 0 && row.hint.startsWith("shorten ")));
  });
});
