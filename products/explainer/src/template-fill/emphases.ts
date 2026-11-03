import { spokenWordIndex, type ScriptBeat } from "../script-schema.js";
import type { Emphasis, Reveal } from "./types.js";

/** The cue's word index in the spoken line, or undefined when the beat never speaks it. */
function wordAt(index: (cue: string) => number, cue: string): number | undefined {
  try {
    return index(cue);
  } catch {
    return undefined;
  }
}

/** The element ids the final slots hold, and the arch-map edges among them, which draw once both their ends land. */
export interface DrawnElements {
  present: ReadonlySet<string>;
  edges: readonly { id: string; from: string; to: string }[];
}

/** The word index each element lands on: its first reveal, or for an edge the later of its two ends. */
function landings(index: (cue: string) => number, reveals: readonly Reveal[], edges: DrawnElements["edges"]): Map<string, number> {
  const landed = new Map<string, number>();
  for (const reveal of reveals) {
    const at = wordAt(index, reveal.atCue);
    if (at !== undefined) landed.set(reveal.target, Math.min(at, landed.get(reveal.target) ?? at));
  }
  for (const edge of edges) landed.set(edge.id, Math.max(landed.get(edge.from) ?? -1, landed.get(edge.to) ?? -1));
  return landed;
}

/**
 * The script cues that name an element the beat already drew, so the view lights it on that word: a later cue on a
 * revealed element, a cue on an element no reveal times (an arch-map edge), or a cue on the claim past its first word.
 * A cue that is an element's own reveal, names an element the slots lack, or lands before its element does lights
 * nothing, since a lit element still unseen would count as a picture change the viewer never sees.
 */
export function cueEmphases(beat: Pick<ScriptBeat, "id" | "spoken" | "visual">, drawn: DrawnElements, reveals: readonly Reveal[]): Emphasis[] {
  const index = spokenWordIndex(beat);
  const landed = landings(index, reveals, drawn.edges);
  const seen = new Set<string>();
  return beat.visual.cues.flatMap(({ target, atCue }) => {
    const at = wordAt(index, atCue);
    const key = `${target} ${atCue}`;
    if (at === undefined || !drawn.present.has(target) || seen.has(key) || at <= (landed.get(target) ?? -1)) return [];
    seen.add(key);
    return [{ target, atCue }];
  });
}
