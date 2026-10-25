import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveBeats } from "../resolve-beat.js";
import { shippedRouter, shippedSpecs } from "../resolve-fixtures.test-helpers.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { fillScript, type FillContext, type FilledBeat, type FilledScript } from "./fill.js";

// Synthetic: an invented parcel desk in three chapters; nothing here quotes a real repo, script or video.
export const fillFixture = (name: string): string => readFileSync(new URL(`../../fixtures/template-fill/${name}`, import.meta.url), "utf8");

// Only the fields the helpers patch; ScriptSchema checks the rest.
const RawScriptSchema = z.looseObject({ beats: z.array(z.looseObject({ id: z.string(), visual: z.record(z.string(), z.unknown()) })) });

export const rawFixture = () => RawScriptSchema.parse(JSON.parse(fillFixture("fill.script.json")));

export const fixtureScript = (): ScriptV1 => ScriptSchema.parse(rawFixture());

/** The fixture with only one beat, in chapter ch1: `visual` is laid over a list beat's visual. */
export function soloScript(visual: Record<string, unknown>, spoken = "The desk runs two lanes now, not one queue, and the crew covers the night shift."): ScriptV1 {
  const raw = rawFixture();
  const base = raw.beats.find((beat) => beat.id === "b2")!;
  return ScriptSchema.parse({ ...raw, beats: [{ ...base, id: "s1", spoken, visual: { ...base.visual, labels: [], cues: [], ...visual } }] });
}

export const resolvedFor = (script: ScriptV1) => ({ beats: resolveBeats(script.beats, shippedSpecs, shippedRouter) });

export const fill = (script: ScriptV1, context: Partial<FillContext> = {}): FilledScript => fillScript(script, resolvedFor(script), { specs: shippedSpecs, ...context });

export function filledBeat(filled: FilledScript, id: string): FilledBeat {
  const found = filled.beats.find((beat) => beat.id === id);
  if (found === undefined) throw new Error(`no filled beat ${id}`);
  return found;
}

/** The one beat of a `soloScript`, filled. */
export const fillSolo = (visual: Record<string, unknown>, spoken?: string, context: Partial<FillContext> = {}): FilledBeat => filledBeat(fill(soloScript(visual, spoken), context), "s1");
