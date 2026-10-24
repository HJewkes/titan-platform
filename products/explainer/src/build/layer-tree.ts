import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BuilderRef, LayerBuild } from "./beat-worker.js";

export interface BuiltLayer {
  beatId: string;
  key: string;
  build: LayerBuild;
}

const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The `custom-layers` tree: one `<beat>.tsx` per built layer and a `layers.json` naming each layer's anchors and element ids. */
export function layerTreeFiles(builder: BuilderRef, layers: readonly BuiltLayer[]): Map<string, string> {
  const unsafe = layers.filter(({ beatId }) => !SAFE_FILE_STEM.test(beatId)).map(({ beatId }) => JSON.stringify(beatId));
  if (unsafe.length > 0) throw new Error(`custom layers: beat ids ${unsafe.join(", ")} cannot name a module file`);
  const sorted = [...layers].sort((a, b) => a.beatId.localeCompare(b.beatId));
  const index = {
    schema: "explainer.custom-layers/v1",
    builder,
    layers: sorted.map(({ beatId, key, build }) => ({
      beat: beatId, module: `${beatId}.tsx`, key, anchors: build.anchors, elements: build.elements, ...(build.sessionId ? { sessionId: build.sessionId } : {}),
    })),
  };
  const files = new Map(sorted.map(({ beatId, build }) => [`${beatId}.tsx`, build.module]));
  files.set("layers.json", `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

/** Writes the tree into `dir`, emptied first so a file left by an interrupted attempt never joins the stored tree. */
export function writeLayerTree(dir: string, files: ReadonlyMap<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(path.join(dir, name), text);
}
