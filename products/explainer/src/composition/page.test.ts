import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildPage, fixtureDurationS, kindsTimeline, renderFrames, servePage, STAGE, type PageServer, type Render } from "./page.test-helpers.js";
import { writeParitySheet } from "./parity-sheet.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** Longer than a capture takes to open the page and read frame 0, so a page that does not wait for its timeline shows it. */
const SLOW_TIMELINE_MS = 1_500;
/** A settled frame with less than this share of non-background pixels reads as blank. */
const INK_FLOOR = 0.005;

let pageDir: string;
let server: PageServer;
let baked: Render;

beforeAll(async () => {
  pageDir = await buildPage();
  server = await servePage(pageDir, SLOW_TIMELINE_MS);
  baked = await renderFrames(server.url("baked.html"));
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await server.close();
  rmSync(pageDir, { recursive: true, force: true });
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const framesSha = (render: Render) => sha(Buffer.from(render.frames.map(sha).join("\n")));

describe("the composition page", { timeout: BROWSER_TIMEOUT_MS }, () => {
  test("a timeline loaded at runtime renders the same frames as the fixture imported at build time", async () => {
    const runtime = await renderFrames(server.url("index.html", "/timelines/fixture.timeline.json"));

    assert.equal(runtime.pageDurationS, fixtureDurationS("fixture.timeline.json"));
    assert.equal(framesSha(runtime), framesSha(baked));
  });

  // Mutation: mount MotionProvider before the timeline resolves (a provisional duration, beats filled in later);
  // the capture reads frame 0 before the held response lands, frame 0 is empty and the frames differ.
  test("a slowly served timeline still renders frame 0 and the build-time frames", async () => {
    const slow = await renderFrames(server.url("index.html", "/slow/fixture.timeline.json"));

    assert.equal(sha(slow.frames[0] ?? Buffer.alloc(0)), sha(baked.frames[0] ?? Buffer.alloc(1)));
    assert.equal(framesSha(slow), framesSha(baked));
  });

  test("one build renders three different timelines, each at its own duration", async () => {
    const names = ["fixture.timeline.json", "second.timeline.json", "third.timeline.json"];

    const renders = await Promise.all(names.map((name) => renderFrames(server.url("index.html", `/timelines/${name}`))));

    assert.deepEqual(renders.map((r) => r.pageDurationS), names.map(fixtureDurationS));
    assert.equal(new Set(renders.map(framesSha)).size, names.length);
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

  test("a stage beat draws its headline, source and chapter in the chrome, and a page beat draws no chrome", async () => {
    const browser = await launch();
    try {
      const { page } = await openCapturePage(browser, server.url("index.html", "/fixtures/kinds.timeline.json"), STAGE);
      const chromeAt = (t: number) =>
        page.evaluate(async (seconds) => {
          window.__titanMotion?.seek(seconds);
          await window.__titanMotion?.ready();
          const shown = [...document.querySelectorAll<HTMLElement>(".xp-chrome")].filter((el) => el.style.visibility === "visible");
          const text = (selector: string) => shown[0]?.querySelector(selector)?.textContent ?? null;
          return { count: shown.length, headline: text(".xp-headline"), source: text(".xp-chips"), chapter: text(".xp-chapter") };
        }, t);

      const chrome = { hook: await chromeAt(1), held: await chromeAt(3.5), catalogue: await chromeAt(6) };

      assert.deepEqual(chrome, {
        hook: { count: 0, headline: null, source: null, chapter: null },
        held: { count: 1, headline: "The router lane shipped its matcher rewrite", source: "verifiedmatch.ts:12-40+1", chapter: "2/4Lanes" },
        catalogue: { count: 0, headline: null, source: null, chapter: null },
      });
    } finally {
      await browser.close();
    }
  });

  // Mutation: make useStageFit return before measuring; the too-wide line renders under the chrome and the page opens.
  test("a held line too wide for its stage box fails the page with the overflow", async () => {
    const browser = await launch();
    try {
      const open = openCapturePage(browser, server.url("index.html", "/timelines/overflow.timeline.json"), STAGE);

      await assert.rejects(open, /page error while loading: too-wide overflows its stage box by \d+ px \(right \d+\)/);
    } finally {
      await browser.close();
    }
  });

  test("the kind sheet writes a first and a settled frame of each kind, none of them blank", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "explainer-kind-sheet-"));
    try {
      const sheet = await writeParitySheet(pageDir, kindsTimeline(), outDir);

      assert.deepEqual(sheet.frames.map((f) => f.file), ["hook", "held", "catalogue"].flatMap((k) => [`kind-${k}-first.png`, `kind-${k}-settled.png`]));
      assert.deepEqual(sheet.frames.filter((f) => f.tag === "settled" && f.inkShare < INK_FLOOR).map((f) => f.kind), []);
      assert.ok(statSync(join(outDir, sheet.sheet)).size > 0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
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
        fileCard: document.body.textContent.includes("lib/cache/store.ts"),
        schemaCard: document.querySelector('[aria-label="Cache entry table"]') !== null,
        annotate: document.body.textContent.includes("entries expire") && document.querySelector('[data-testid="catalogue-annotate"] svg path') !== null,
      }));

      assert.deepEqual(shown, { fileCard: true, schemaCard: true, annotate: true });
    } finally {
      await browser.close();
    }
  });
});
