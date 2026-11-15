import type { CueResolver } from "../cues.js";

export interface SfxRequest {
  sfxId: string;
  beatId: string;
  /** A cue word as `cueResolverFromWords` reads it: "word" or "word#n". */
  cue: string;
  /** Seconds the sound's peak sits after its start, so the peak lands on the cue word. */
  anchorS: number;
}

export interface SfxHit {
  sfxId: string;
  atS: number;
}

export interface Placement {
  hits: SfxHit[];
  warnings: string[];
}

/** Two hits closer than this read as one; the later is dropped. */
export const MIN_HIT_SPACING_S = 0.25;

/** Places each sound at beat start + cue word start - anchor, in time order, dropping a hit too close to the one kept before it. */
export function placeSfx(requests: readonly SfxRequest[], beatStarts: Readonly<Record<string, number>>, resolve: CueResolver): Placement {
  const placed = requests
    .map((r) => ({ sfxId: r.sfxId, atS: beatStart(beatStarts, r.beatId) + resolve(r.beatId, r.cue) - r.anchorS }))
    .sort((a, b) => a.atS - b.atS);
  const hits: SfxHit[] = [];
  const warnings: string[] = [];
  for (const hit of placed) {
    const last = hits[hits.length - 1];
    if (last && hit.atS - last.atS < MIN_HIT_SPACING_S) {
      warnings.push(`sfx ${hit.sfxId} at ${hit.atS.toFixed(3)} s is within ${MIN_HIT_SPACING_S} s of ${last.sfxId} at ${last.atS.toFixed(3)} s; dropped`);
    } else hits.push(hit);
  }
  return { hits, warnings };
}

function beatStart(starts: Readonly<Record<string, number>>, beatId: string): number {
  const start = starts[beatId];
  if (start === undefined) throw new Error(`no start for beat ${beatId}`);
  return start;
}
