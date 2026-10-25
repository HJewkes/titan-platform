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

export const SWEEP_HZ = 2
/** Float slack on the grid's comparisons, as in the archived sweep this ports. */
const GRID_EPS_S = 1e-6

export interface SweepOptions<B extends MomentBeat> {
  /** Samples per second, on a grid counted from the start of the video, not from each beat. */
  hz?: number
  /** Seconds before the beat's end that its picture is settled; an outro that fades out passes its fade. Default 0. */
  settleBy?: (beat: B) => number
}

const round3 = (s: number): number => Math.round(s * 1000) / 1000

function gridTimes(startS: number, endS: number, hz: number): number[] {
  const ts: number[] = []
  // Start one sample early so float error in startS * hz never skips the beat's first sample.
  for (let k = Math.max(0, Math.floor(startS * hz) - 1), t = round3(k / hz); t < endS - GRID_EPS_S; k++, t = round3(k / hz)) {
    if (t >= startS - GRID_EPS_S) ts.push(t)
  }
  return ts
}

/** The last sample before `settledS`, or the beat's last sample when none is. */
function settledSample(ts: readonly number[], settledS: number): number | undefined {
  return ts.filter((t) => t < settledS - GRID_EPS_S).at(-1) ?? ts.at(-1)
}

/**
 * Fixed-rate samples over a whole video. Each beat's settled sample is its `end` moment and every other sample is a
 * `cue` moment, so held.ts treats them as it treats cue moments. Samples inside a settle window are still taken.
 */
export function sweepMoments<B extends MomentBeat>(beats: readonly B[], options: SweepOptions<B> = {}): Moment[] {
  const hz = options.hz ?? SWEEP_HZ
  let startS = 0
  return beats.flatMap((beat) => {
    const endS = startS + beat.durationS
    const ts = gridTimes(startS, endS, hz)
    const settled = settledSample(ts, endS - (options.settleBy?.(beat) ?? 0))
    const beatStartS = startS
    startS = endS
    return ts.map((t): Moment => ({ beat: beat.id, local: round3(t - beatStartS), t, kind: t === settled ? 'end' : 'cue', why: `${hz} Hz` }))
  })
}
