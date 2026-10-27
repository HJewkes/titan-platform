import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, openCapturePage } from "@titan-design/frame-capture";
import { afterAll, beforeAll, describe, test } from "vitest";
import { cueGate } from "../qa/cue-gate.js";
import { loadQaGate } from "../qa/gate-profile.js";
import { chromiumQaEngine } from "../qa/qa-engine.js";
import { timelineFromArtifact } from "../qa/qa-timeline.js";
import { buildPage, fixtureDurationS, kindsTimeline, renderFrames, servePage, STAGE, type PageServer, type Render } from "./page.test-helpers.js";
import { sheetKind, writeParitySheet } from "./parity-sheet.js";
import { resolveBeat } from "./registry.js";
import type { TimelineBeat } from "./timeline.js";

const BROWSER_TIMEOUT_MS = 240_000;
/** Longer than a capture takes to open the page and read frame 0, so a page that does not wait for its timeline shows it. */
const SLOW_TIMELINE_MS = 1_500;
/** A settled frame with less than this share of non-background pixels reads as blank. */
const INK_FLOOR = 0.005;
/** How far either side of a reveal time the reveal check looks: the element is out just before and on just after. */
const BEFORE_REVEAL_S = 0.05;
const AFTER_REVEAL_S = 0.3;
const KINDS_URL = "/fixtures/kinds.timeline.json";

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

interface KindsPage {
  page: Awaited<ReturnType<typeof openCapturePage>>["page"];
  seek(t: number): Promise<void>;
  errors: string[];
}

/** The kinds timeline on the page, seekable, with every page error it throws on the way. */
async function withKindsPage(use: (kinds: KindsPage) => Promise<void>): Promise<void> {
  const browser = await launch();
  try {
    const { page } = await openCapturePage(browser, server.url("index.html", KINDS_URL), STAGE);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const seek = (t: number) =>
      page.evaluate(async (seconds) => {
        window.__titanMotion?.seek(seconds);
        await window.__titanMotion?.ready();
      }, t);
    await use({ page, seek, errors });
  } finally {
    await browser.close();
  }
}

/** How visible slot element `target` of a beat is: its most opaque leaf (a row, a title word), through every ancestor. */
function revealOpacity({ beat, target }: { beat: string; target: string }): number {
  const el = document.querySelector(`[data-stage="${beat}"] [data-reveal="${target}"]`);
  if (!el) return -1;
  const opacity = (node: Element): number => {
    if (getComputedStyle(node).visibility !== "visible") return 0;
    let p = 1;
    for (let at: Element | null = node; at; at = at.parentElement) p *= Number(getComputedStyle(at).opacity);
    return p;
  };
  return Math.max(...[el, ...el.querySelectorAll("*")].filter((node) => node.children.length === 0).map(opacity));
}

async function shownAt({ page, seek }: KindsPage, beat: TimelineBeat, target: string, local: number): Promise<number> {
  await seek(beat.startS + local);
  return page.evaluate(revealOpacity, { beat: beat.id, target });
}

/** Whether a stage beat's frame is shown with text in it; null for a page beat, which has no stage. */
function stageDrawn(beat: string): boolean | null {
  const frame = document.querySelector<HTMLElement>(`[data-stage="${beat}"] .beat-frame`);
  return frame ? frame.style.visibility === "visible" && frame.textContent.trim() !== "" : null;
}

/** The text of each list row of a beat with any opacity, in stage order. */
function shownRowTexts(beat: string): string[] {
  const rows = [...document.querySelectorAll(`[data-stage="${beat}"] .ex-list-row`)];
  return rows.filter((row) => Number(getComputedStyle(row).opacity) > 0).map((row) => row.querySelector(".ex-list-text")?.textContent ?? "");
}

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

  // Mutation: draw every chart kind past bar as a line; a gauge then renders as a line chart and the page opens.
  test("a chart of a kind with no view (gauge) fails the page and names the kind", async () => {
    const browser = await launch();
    try {
      const open = openCapturePage(browser, server.url("index.html", "/timelines/gauge-chart.timeline.json"), STAGE);

      await assert.rejects(open, /page error while loading: chart kind "gauge" is not drawn yet; drawn kinds: bar, line/);
    } finally {
      await browser.close();
    }
  });

  // Mutation: let the arch-map take any node count; six nodes then fail as a stage overflow, not as this refusal.
  test("an arch-map of six nodes is refused, since the path holds two to five", async () => {
    const browser = await launch();
    try {
      const open = openCapturePage(browser, server.url("index.html", "/timelines/six-node-map.timeline.json"), STAGE);

      await assert.rejects(open, /page error while loading: arch-map draws 2 to 5 nodes, not 6/);
    } finally {
      await browser.close();
    }
  });

  // Mutation: skip the edge check; the map_state map with no edges then draws Ledger -> Scanner and the page opens.
  test("an arch-map whose edges are not the node path is refused, so no link is drawn that the map lacks", async () => {
    const browser = await launch();
    try {
      const open = openCapturePage(browser, server.url("index.html", "/timelines/branching-map.timeline.json"), STAGE);

      await assert.rejects(open, /page error while loading: arch-map draws only the path nodes-1 -> nodes-2; the map's edges are \[\]/);
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

      const kinds = [...new Set(kindsTimeline().beats.map(sheetKind))];
      assert.deepEqual(sheet.frames.map((f) => f.file), kinds.flatMap((k) => [`kind-${k}-first.png`, `kind-${k}-settled.png`]));
      assert.deepEqual(sheet.frames.filter((f) => f.tag === "settled" && f.inkShare < INK_FLOOR).map((f) => f.kind), []);
      assert.ok(statSync(join(outDir, sheet.sheet)).size > 0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  // Mutation: drop the verdict beat's qaLeadLine hint; its verdict standing alone before the first reason reads late-fill.
  // The page kinds (hook, catalogue) are TP-2991's showcase, drawn outside the stage and the doctrine kinds the gate reads.
  test("the QA cue gate holds no error on the kind sheet's stage beats", async () => {
    const timeline = kindsTimeline();
    const stage = { ...timeline, beats: timeline.beats.filter((beat) => resolveBeat(beat.kind).stage) };
    const lead = new Set(stage.beats.filter((beat) => beat.hints?.qaLeadLine).map((beat) => beat.id));

    const result = await cueGate(chromiumQaEngine(), server.url("index.html", KINDS_URL), timelineFromArtifact(stage), loadQaGate("daily-overview"), { lead });

    assert.deepEqual(result.held.errors.map(({ kind, beat, reason }) => ({ kind, beat, reason })), []);
  });

  test("every beat on the kind sheet's timeline draws, stage beats with their content, and no page error", async () => {
    await withKindsPage(async ({ page, seek, errors }) => {
      const blank: string[] = [];
      for (const beat of kindsTimeline().beats) {
        await seek(beat.startS + beat.durationS / 2);
        if ((await page.evaluate(stageDrawn, beat.id)) === false) blank.push(beat.id);
      }

      assert.deepEqual({ blank, errors }, { blank: [], errors: [] });
    });
  });

  // Mutation: land every list row at 0 s instead of on its reveal; each row shows before its cue word.
  test("each revealed element is hidden just before its reveal time and shown just after", async () => {
    await withKindsPage(async (kinds) => {
      const wrong: string[] = [];
      for (const beat of kindsTimeline().beats) {
        for (const { target, atS } of beat.reveals ?? []) {
          if (atS > BEFORE_REVEAL_S) {
            const before = await shownAt(kinds, beat, target, atS - BEFORE_REVEAL_S);
            if (before !== 0) wrong.push(`${beat.id} ${target} before: ${before}`);
          }
          const after = await shownAt(kinds, beat, target, atS + AFTER_REVEAL_S);
          if (!(after > 0.1)) wrong.push(`${beat.id} ${target} after: ${after}`);
        }
      }

      assert.deepEqual(wrong, []);
    });
  });

  // Mutation: drop the held rows from a continuation's slots; it opens on its own row alone.
  test("a continuation beat opens on the rows its lead ended with", async () => {
    const { beats } = kindsTimeline();
    const at = beats.findIndex((beat) => beat.hints?.continues !== undefined);
    const [lead, next] = [beats[at - 1]!, beats[at]!];

    await withKindsPage(async ({ page, seek }) => {
      const rowsAt = async (beat: TimelineBeat, local: number) => {
        await seek(beat.startS + local);
        return page.evaluate(shownRowTexts, beat.id);
      };
      const leadEnd = await rowsAt(lead, lead.durationS - 0.1);
      const opening = await rowsAt(next, AFTER_REVEAL_S + Math.min(...(next.reveals ?? []).map((r) => r.atS)));

      assert.deepEqual(opening, leadEnd.slice(-opening.length));
      assert.ok(opening.length >= 1);
    });
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
