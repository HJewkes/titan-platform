import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { z } from "zod";
import { LAYER_IMPORT_ALLOWLIST } from "../build/compile-gate.js";
import { SAFE_FILE_STEM } from "../build/layer-tree.js";
import { LAYER_HOST_GLOBAL } from "../composition/layer-host.js";
import type { Timeline } from "../composition/timeline.js";

/** Where the bundled layers sit in the served page tree, so a timeline names each one relative to the page. */
export const LAYERS_PAGE_DIR = "custom-layers";

const LayersIndexSchema = z.object({
  schema: z.literal("explainer.custom-layers/v1"),
  layers: z.array(z.object({ beat: z.string().min(1), module: z.string().min(1), anchors: z.array(z.string()).min(1) })),
});

/** What the timeline says of one drawn custom layer: the module the page imports and the cells it declares. */
export interface PageLayer {
  module: string;
  anchors: string[];
}

const HOST = "layer-host";

// Each allowed import becomes the page's own module, read off the global the page publishes. As CommonJS, esbuild
// turns every named import into a property read, so no list of export names has to be kept here.
const hostPlugin: Plugin = {
  name: "layer-host",
  setup(setup) {
    setup.onResolve({ filter: /.*/ }, ({ path: spec }) =>
      LAYER_IMPORT_ALLOWLIST.includes(spec) ? { path: spec, namespace: HOST } : { errors: [{ text: `import "${spec}" is not allowed in a custom layer` }] });
    setup.onLoad({ filter: /.*/, namespace: HOST }, ({ path: spec }) => ({
      contents: `module.exports = globalThis[${JSON.stringify(LAYER_HOST_GLOBAL)}][${JSON.stringify(spec)}];`, loader: "js",
    }));
  },
};

/** One layer's TSX as an ESM file the page can import, sharing the page's React and motion modules. */
export async function bundleLayer(source: string, sourcefile: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, loader: "tsx", sourcefile }, bundle: true, write: false, format: "esm", jsx: "automatic", logLevel: "silent", plugins: [hostPlugin],
  });
  return result.outputFiles[0]!.text;
}

function moduleSource(treeDir: string, beat: string, module: string): string {
  if (!SAFE_FILE_STEM.test(module)) throw new Error(`custom layer for beat "${beat}": module "${module}" is not a file in the custom-layers tree`);
  const file = path.join(treeDir, module);
  if (!existsSync(file)) throw new Error(`custom layer for beat "${beat}": module "${module}" is missing from the custom-layers tree`);
  return readFileSync(file, "utf8");
}

/**
 * Bundles the layer of each custom beat in `beats` (script id → storyboard id) from the `custom-layers` tree into
 * `<pageDir>/custom-layers/<storyboard id>.js`. A beat the tree has no layer for, or a module that will not bundle,
 * throws with its name, so a custom beat is never rendered blank.
 */
export async function stageCustomLayers(treeDir: string, beats: ReadonlyMap<string, string>, pageDir: string): Promise<Map<string, PageLayer>> {
  const index = LayersIndexSchema.parse(JSON.parse(readFileSync(path.join(treeDir, "layers.json"), "utf8")));
  mkdirSync(path.join(pageDir, LAYERS_PAGE_DIR), { recursive: true });
  const staged = new Map<string, PageLayer>();
  for (const [scriptId, boardId] of beats) {
    const entry = index.layers.find((layer) => layer.beat === scriptId);
    if (!entry) throw new Error(`custom layer for beat "${scriptId}" is not in the custom-layers tree`);
    const bundled = await bundleLayer(moduleSource(treeDir, scriptId, entry.module), entry.module).catch((error: unknown) => {
      throw new Error(`custom layer for beat "${scriptId}": module "${entry.module}" does not bundle: ${error instanceof Error ? error.message : String(error)}`);
    });
    const file = `${LAYERS_PAGE_DIR}/${boardId}.js`;
    writeFileSync(path.join(pageDir, file), bundled);
    staged.set(boardId, { module: `./${file}`, anchors: entry.anchors });
  }
  return staged;
}

/** The timeline with each staged custom beat drawn by its layer. */
export function withCustomLayers(timeline: Timeline, layers: ReadonlyMap<string, PageLayer>): Timeline {
  return { ...timeline, beats: timeline.beats.map((beat) => {
    const layer = layers.get(beat.id);
    return layer ? { ...beat, layer: "custom" as const, module: layer.module, anchors: layer.anchors } : beat;
  }) };
}
