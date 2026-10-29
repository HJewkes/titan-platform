import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_OPTIONS, type InspectOptions, type ProbedMoment } from "@titan-design/render-qa";
import { badTextRows, distinctRows, plannedCues, qaRows, revealMoments, type LayerCheckInput, type LayerTextCheck, type LayerTextRow } from "../build/layer-text.js";
import { layerTreeFiles, writeLayerTree } from "../build/layer-tree.js";
import type { Timeline } from "../composition/timeline.js";
import { chromiumQaEngine, type QaEngine, type QaPage } from "../qa/qa-engine.js";
import { narrationRows } from "../qa/layer-narration.js";
import { defaultCompositionPage, servePage, type BuiltPage } from "./composition-page.js";
import { stageCustomLayers, withCustomLayers } from "./custom-layers.js";

interface LayerTextCheckDeps {
  /** The composition page the render draws with; the host's cached build by default. */
  page?: () => Promise<BuiltPage>;
  engine?: Pick<QaEngine, "open">;
  /** qa's inspector options, its own defaults unless a gate profile overrides them. */
  options?: InspectOptions;
}

/** One custom beat, the whole timeline, drawn by the layer under check. */
async function layerPage(input: LayerCheckInput, built: BuiltPage, scratch: string): Promise<{ pageDir: string; timeline: Timeline }> {
  const pageDir = path.join(scratch, "page");
  const treeDir = path.join(scratch, "custom-layers");
  cpSync(built.dir, pageDir, { recursive: true });
  writeLayerTree(treeDir, layerTreeFiles(input.builder, [input.layer]));
  const { beatId } = input.layer;
  const layers = await stageCustomLayers(treeDir, new Map([[beatId, beatId]]), pageDir);
  const durationS = input.packet.planned_s;
  const beat = { id: beatId, kind: "custom", startS: 0, durationS, cues: plannedCues(input.packet), slots: {} };
  return { pageDir, timeline: withCustomLayers({ durationS, beats: [beat] }, layers) };
}

// Virtual time only runs forward, so each moment is inspected and probed before the next is sought.
async function rowsAt(page: QaPage, packet: LayerCheckInput["packet"], moments: readonly number[], options: InspectOptions): Promise<LayerTextRow[]> {
  const beat = packet.beat_id;
  const rows: LayerTextRow[] = [];
  const probed: ProbedMoment[] = [];
  for (const t of moments) {
    rows.push(...qaRows(beat, t, (await page.inspectAt(t, options)).findings));
    probed.push(...(await page.probe([{ beat, t }])));
  }
  return distinctRows([...rows, ...badTextRows(beat, probed), ...narrationRows(beat, packet.spoken, probed)]);
}

/**
 * The $0 check after a layer build: the layer alone on the composition page, seeked to each reveal point, held to qa's
 * small-text and under-chrome rules at qa's thresholds, to the bad-text rule, and to qa's narration-facts and G10 rules
 * against the beat's spoken words. No model call; Chromium only.
 */
export function chromiumLayerTextCheck(deps: LayerTextCheckDeps = {}): LayerTextCheck {
  const engine = deps.engine ?? chromiumQaEngine();
  const options = deps.options ?? DEFAULT_OPTIONS;
  return async (input) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "explainer-layer-check-"));
    try {
      const { pageDir, timeline } = await layerPage(input, await (deps.page ?? defaultCompositionPage)(), scratch);
      const file = path.join(scratch, "timeline.json");
      writeFileSync(file, JSON.stringify(timeline));
      const served = await servePage(pageDir, file);
      try {
        const page = await engine.open(served.url, options, []);
        try {
          return await rowsAt(page, { ...input.packet, beat_id: input.layer.beatId }, revealMoments(timeline.beats[0]!.cues ?? {}, timeline.durationS), options);
        } finally {
          await page.close();
        }
      } finally {
        await served.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}
