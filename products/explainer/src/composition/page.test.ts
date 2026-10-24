import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildPage, fixtureDurationS, renderMp4, servePage, STAGE, type PageServer, type Render } from "./page.test-helpers.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** Longer than a capture takes to open the page and read frame 0, so a page that does not wait for its timeline shows it. */
const SLOW_TIMELINE_MS = 1_500;

let pageDir: string;
let server: PageServer;
let baked: Render;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, SLOW_TIMELINE_MS);
  baked = await renderMp4(server.url("baked.html"));
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the composition page", { timeout: BROWSER_TIMEOUT_MS }, () => {
  test("a timeline loaded at runtime renders the same MP4 bytes as the fixture imported at build time", async () => {
    const runtime = await renderMp4(server.url("index.html", "/timelines/fixture.timeline.json"));

    assert.equal(runtime.pageDurationS, fixtureDurationS("fixture.timeline.json"));
    assert.equal(sha(runtime.mp4), sha(baked.mp4));
  });

  // Mutation: mount MotionProvider before the timeline resolves (a provisional duration, beats filled in later);
  // the capture reads frame 0 before the held response lands, frame 0 is empty and the MP4 bytes differ.
  test("a slowly served timeline still renders frame 0 and the build-time bytes", async () => {
    const slow = await renderMp4(server.url("index.html", "/slow/fixture.timeline.json"));

    assert.equal(sha(slow.frames[0] ?? Buffer.alloc(0)), sha(baked.frames[0] ?? Buffer.alloc(1)));
    assert.equal(sha(slow.mp4), sha(baked.mp4));
  });

  test("one build renders three different timelines, each at its own duration", async () => {
    const names = ["fixture.timeline.json", "second.timeline.json", "third.timeline.json"];

    const renders = await Promise.all(names.map((name) => renderMp4(server.url("index.html", `/timelines/${name}`))));

    assert.deepEqual(renders.map((r) => r.pageDurationS), names.map(fixtureDurationS));
    assert.equal(new Set(renders.map((r) => sha(r.mp4))).size, names.length);
  });

  test("a beat kind the registry does not know fails the page", async () => {
    const browser = await launch();
    try {
      const open = openCapturePage(browser, server.url("index.html", "/timelines/unknown-kind.timeline.json"), STAGE);

      await assert.rejects(open, /page error while loading: unknown beat kind "hologram"/);
    } finally {
      await browser.close();
    }
  });

  test("a provisional timeline is stamped DRAFT and a spoken one is not", async () => {
    const browser = await launch();
    try {
      const badgeOn = async (name: string) => {
        const { page } = await openCapturePage(browser, server.url("index.html", `/timelines/${name}`), STAGE);
        return page.evaluate(() => document.querySelector('[data-testid="draft-badge"]')?.textContent ?? null);
      };

      const badges = [await badgeOn("second.timeline.json"), await badgeOn("fixture.timeline.json")];

      assert.deepEqual(badges, ["DRAFT", null]);
    } finally {
      await browser.close();
    }
  });

  test("the catalogue beat renders react-ui's FileCard, SchemaCard and Annotate live", async () => {
    const browser = await launch();
    try {
      const { page } = await openCapturePage(browser, server.url("index.html", "/timelines/third.timeline.json"), STAGE);
      await page.evaluate(async () => {
        window.__titanMotion?.seek(1.4);
        await window.__titanMotion?.ready();
      });

      const shown = await page.evaluate(() => ({
        fileCard: document.body.textContent?.includes("lib/cache/store.ts") === true,
        schemaCard: document.querySelector('[aria-label="Cache entry table"]') !== null,
        annotate: document.body.textContent?.includes("entries expire") === true && document.querySelector('[data-testid="catalogue-annotate"] svg path') !== null,
      }));

      assert.deepEqual(shown, { fileCard: true, schemaCard: true, annotate: true });
    } finally {
      await browser.close();
    }
  });
});
