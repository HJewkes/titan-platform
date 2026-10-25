import type { z } from "zod";
import { loadBeatSpecs } from "../beat-load.js";
import { emphasisTargetGate } from "../emphasis-gate.js";
import type { ResolvedSchema } from "../resolve-stage.js";
import type { ScriptV1 } from "../script-schema.js";
import { FillError, fillScript, type FilledScript } from "../template-fill/fill.js";

type Resolved = z.infer<typeof ResolvedSchema>;

/**
 * The template fill's verdict on an edited script: each problem the filled slots raise. `pinned` is the base run's
 * `slots` pin, not the slots its resolve stored, which stands in for the derived layer as it does at resolve.
 */
export type FillCheck = (script: ScriptV1, resolved: Resolved, pinned?: Readonly<Record<string, unknown>>) => string[];

/** Each emphasis cue of a filled beat that names no single element of the spec the fill drew, fallbacks included. */
function emphasisProblems(script: ScriptV1, filled: FilledScript): string[] {
  const drawn = new Map(filled.beats.map((beat) => [beat.id, beat]));
  const beats = script.beats.flatMap(({ id, visual }) => {
    const beat = drawn.get(id);
    return beat ? [{ id, visual: { ...visual, beat: beat.spec } }] : [];
  });
  const slots = Object.fromEntries(filled.beats.map((beat) => [beat.id, beat.slots]));
  return emphasisTargetGate({ beats, specs: loadBeatSpecs(), slots }).map((f) => `beats.${f.beat}.visual.cues.${f.cue}: ${f.problem}: ${f.detail}`);
}

/** The whole-script fill, then the emphasis-target gate on what it filled; a refused beat stops at the fill. */
export const fillProblems: FillCheck = (script, resolved, pinned) => {
  try {
    return emphasisProblems(script, fillScript(script, resolved, { specs: loadBeatSpecs(), ...(pinned ? { pinned } : {}) }));
  } catch (error) {
    if (error instanceof FillError) return error.refusals.map((r) => `beats.${r.beat}: ${r.detail}`);
    throw error;
  }
};
