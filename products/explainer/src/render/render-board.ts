import { z } from "zod";
import { loadBeatSpecs } from "../beat-load.js";
import { codeSource } from "../resolve-citation.js";
import { keptBeats, ResolvedSchema } from "../resolve-stage.js";
import { ScriptSchema } from "../script-schema.js";
import type { Storyboard } from "../storyboard.js";
import { fillScript } from "../template-fill/fill.js";
import type { ArtifactStore } from "../workflow/artifacts.js";
import { storyboardIds } from "./beat-ids.js";
import { boardFromFill, type PageExtras } from "./board-from-fill.js";

interface BoardInput {
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText">;
}

interface RenderBoard {
  board: Storyboard;
  /** The page extras by storyboard id, for compileTimeline. */
  extras: Map<string, PageExtras>;
  /** Script beat id to storyboard id, for words.json and the voiced wavs. */
  ids: Map<string, string>;
  /** The custom-layer beats render draws, script id to storyboard id. */
  custom: Map<string, string>;
}

const PinSchema = z.record(z.string(), z.unknown());

function read(input: BoardInput, name: string): string | undefined {
  const sha = input.artifacts[name];
  return sha === undefined ? undefined : input.store.readText(sha);
}

function required(input: BoardInput, name: string): unknown {
  const text = read(input, name);
  if (text === undefined) throw new Error(`stage render needs artifact "${name}", which no earlier stage produced`);
  return JSON.parse(text);
}

/**
 * The storyboard render draws: the template fill over the beats resolve kept, as resolve gated it (cited code, the
 * owner's `slots` pin, else the `generated-slots` layer resolve stored). A custom-layer beat is filled from its
 * template spec too, which it is drawn from when the run has no built layer for it; a refused beat throws the fill's error.
 */
export function renderBoard(input: BoardInput): RenderBoard {
  const script = ScriptSchema.parse(required(input, "script"));
  const resolved = ResolvedSchema.parse(required(input, "resolved"));
  const pin = read(input, "slots") ?? read(input, "generated-slots");
  const code = read(input, "code");
  const kept = { ...script, beats: keptBeats(script.beats, resolved) };
  const asTemplate = { beats: resolved.beats.map((row) => ({ ...row, layer: "template" as const })) };
  const filled = fillScript(kept, asTemplate, {
    specs: loadBeatSpecs(), ...(code === undefined ? {} : { code: codeSource(code) }), ...(pin === undefined ? {} : { pinned: PinSchema.parse(JSON.parse(pin)) }),
  });
  const ids = storyboardIds(script, resolved);
  const custom = new Map(resolved.beats.filter((row) => row.layer === "custom" && ids.has(row.id)).map((row) => [row.id, ids.get(row.id)!]));
  return { ...boardFromFill(script, filled, ids), ids, custom };
}
