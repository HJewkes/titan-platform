/**
 * Where the gate looks: each beat's midpoint, 0.9 s after each cue, and 0.2 s before the beat ends. The cue
 * moments catch what a cue brought in once it has settled; the end moment is the settled picture. The start
 * moment is the beat's first frame (the boundary with the beat before) and the enter moment 0.3 s in, mid camera
 * move; held.ts reads only the frame kinds there. One browser seeks to all of them (about 70 ms each), so there is
 * no re-render and no per-frame check.
 */

export const AFTER_CUE_S = 0.9
/** Cue moments closer than this to a kept moment add nothing the first one did not show. */
export const MIN_GAP_S = 0.6
export const END_BACKOFF_S = 0.2
export const ENTER_S = 0.3

export interface MomentBeat {
  id: string
  durationS: number
}

export interface MomentCue {
  beat: string
  /** Seconds from the beat's start. */
  atS: number
}

export type MomentKind = 'mid' | 'cue' | 'end' | 'start' | 'enter'

export interface Moment {
  beat: string
  /** Seconds from the beat's start. */
  local: number
  /** Seconds from the start of the video. */
  t: number
  kind: MomentKind
  why: string
}

function beatMoments(beat: MomentBeat, startS: number, cueTimes: readonly number[]): Moment[] {
  const d = beat.durationS
  const at = (local: number, kind: MomentKind, why: string): Moment => ({ beat: beat.id, local, t: startS + local, kind, why })
  const kept = [at(d / 2, 'mid', 'mid'), at(Math.max(0, d - END_BACKOFF_S), 'end', 'end')]
  const wanted = [...new Set(cueTimes.map((c) => Math.min(c + AFTER_CUE_S, d - END_BACKOFF_S)))].sort((a, b) => a - b)
  for (const local of wanted) {
    if (kept.every((m) => Math.abs(m.local - local) >= MIN_GAP_S)) kept.push(at(local, 'cue', `cue@${(local - AFTER_CUE_S).toFixed(2)}`))
  }
  return [at(0, 'start', 'start'), at(ENTER_S, 'enter', 'enter'), ...kept].sort((a, b) => a.local - b.local)
}

/** Moments for a whole video, in time order. `beats` are in play order and run back to back. */
export function buildMoments(beats: readonly MomentBeat[], cues: readonly MomentCue[]): Moment[] {
  let startS = 0
  return beats.flatMap((beat) => {
    const moments = beatMoments(beat, startS, cues.filter((c) => c.beat === beat.id).map((c) => c.atS))
    startS += beat.durationS
    return moments
  })
}
