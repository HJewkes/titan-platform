import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import { afterAll, beforeAll, describe, test } from "vitest";
import { chromiumStageFitScan } from "../render/stage-fit-scan.js";
import { buildPage, fixtureDurationS, renderFrames, servePage, STAGE, type PageServer } from "./page.test-helpers.js";
import { parseTimeline } from "./timeline.js";

const BROWSER_TIMEOUT_MS = 240_000;
const FLOOR_PX = 40;
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

let pageDir: string;
let server: PageServer;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, 0);
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

/** The served fixture page at `t`, in report mode when asked, with what `read` returns from it and the page errors. */
async function atMoment<T>(fixture: string, t: number, read: () => T, report = false): Promise<{ value: T; errors: string[] }> {
  const browser = await launch();
  try {
    const url = `${server.url("index.html", `/timelines/${fixture}`)}${report ? "&stage-fit=report" : ""}`;
    const { page } = await openCapturePage(browser, url, STAGE);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async (seconds) => {
      window.__titanMotion?.seek(seconds);
      await window.__titanMotion?.ready();
    }, t);
    return { value: await page.evaluate(read), errors };
  } finally {
    await browser.close();
  }
}

function smallestTextPx(): number {
  const leaves = [...document.querySelectorAll(".beat-frame *")].filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() !== "");
  return Math.min(...leaves.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
}

describe("the stage fit", { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: make fitToStage return the overflow at scale 1; the four long labels then fail the page on its first frame.
  test("a stat beat whose long labels overrun the row shrinks into its stage box, every frame, no text under 40 px", async () => {
    const fixture = "stat-fit.timeline.json";

    const render = await renderFrames(server.url("index.html", `/timelines/${fixture}`));
    const settled = await atMoment(fixture, 2.9, smallestTextPx);

    assert.equal(render.pageDurationS, fixtureDurationS(fixture));
    assert.deepEqual(settled.errors, []);
    assert.ok(settled.value >= FLOOR_PX, `smallest text ${settled.value} px`);
  });

  // Mutation: name a row's element by its own class alone; the row then loses which figure to shorten.
  test("a stat label too long even at the type floor is a row naming the beat, the label, the px and a shorten hint", async () => {
    const { value: row, errors } = await atMoment("stat-floor.timeline.json", 2.9, () => window.__stageOverflows?.["label-past-floor"], true);

    assert.deepEqual(errors, []);
    assert.equal(row?.element, "figures-2 beat-stat-label");
    assert.ok((row?.px ?? 0) > 0);
    assert.match(row?.hint ?? "", /^shorten figures-2 beat-stat-label "a synthetic label far too long[^"]*" to <= \d+ chars$/);
  });

  // Mutation: throw on the first overflow in report mode too; the scan then stops at the stat beat and never sees the line.
  test("one stage-fit scan reports every beat past its stage box, in beat order", async () => {
    const fixture = "stat-floor.timeline.json";
    const timeline = parseTimeline(JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8")));

    const rows = await chromiumStageFitScan(server.url("index.html", `/timelines/${fixture}`), timeline, STAGE);

    assert.deepEqual(rows.map((row) => row.beat), ["label-past-floor", "line-past-floor"]);
    assert.ok(rows.every((row) => row.px > 0 && row.hint.startsWith("shorten ")));
  });
});
