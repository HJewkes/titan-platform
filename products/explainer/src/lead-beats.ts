import type { BeatSpec } from "./beat-schema.js";
import type { ScriptV1 } from "./script-schema.js";
import type { SpineV1 } from "./spine-schema.js";

/** A chapter's lead beat: the beat spec the spine's chapter order names, as the audition pick chose it. */
export interface LeadBeat {
  chapter: string;
  spec: BeatSpec;
}

const targetsOf = (spec: BeatSpec | undefined): readonly string[] => spec?.emphasis?.targets ?? [];

/** Each chapter's lead beat spec; a chapter row naming no beat, or one the registry lacks, has none. */
export function leadBeats(spine: SpineV1, specs: ReadonlyMap<string, BeatSpec>): LeadBeat[] {
  return spine.chapters.flatMap(({ chapter, beat }) => {
    const spec = beat === undefined ? undefined : specs.get(beat);
    return spec ? [{ chapter, spec }] : [];
  });
}

/** One prompt line per lead beat: the spec, its emphasis target lists and its recipe. */
export function leadBeatLines(leads: readonly LeadBeat[]): string[] {
  return leads.map(({ chapter, spec }) => {
    const targets = targetsOf(spec);
    const cues = targets.length > 0 ? `emphasis targets: ${targets.join(", ")}` : "no emphasis targets, so no cue is needed";
    return `- ${chapter}: ${spec.type} (${cues}). ${spec.summary} ${spec.recipe}`;
  });
}

/**
 * What leaves an emphasis target uncued, so the render would hold a static frame: a beat whose beat spec has emphasis
 * targets and no cue, a beat naming a spec the registry lacks, and a chapter whose lead beat spec, having targets,
 * is on none of its beats. A spec with no emphasis targets needs no cue.
 */
export function uncuedTargets(script: Pick<ScriptV1, "beats">, leads: readonly LeadBeat[], specs: ReadonlyMap<string, BeatSpec>): string[] {
  const beats = script.beats.flatMap(({ id, visual }) => {
    if (visual.beat === undefined) return [];
    if (!specs.has(visual.beat)) return [`${id} names beat spec ${visual.beat}, which the registry lacks`];
    const targets = targetsOf(specs.get(visual.beat));
    return targets.length > 0 && visual.cues.length === 0 ? [`${id} (${visual.beat}) has no cue for ${targets.join(", ")}`] : [];
  });
  const chapters = leads.flatMap(({ chapter, spec }) => {
    const placed = script.beats.some((beat) => beat.chapter === chapter && beat.visual.beat === spec.type);
    return targetsOf(spec).length > 0 && !placed ? [`${chapter}'s lead beat ${spec.type} is on none of its beats`] : [];
  });
  return [...beats, ...chapters];
}
