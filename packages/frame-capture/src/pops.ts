// The halving test is adapted from anatomy, kit/turn-audit.mjs L969-L986 at e9488296
// (https://github.com/wheresryan22/anatomy/blob/e9488296/kit/turn-audit.mjs#L969-L986).
// MIT License, Copyright (c) 2026 Ryan. The full licence text is in the repository NOTICE.
//
// Changes from the source: the frame is any value a caller-supplied `delta` can compare, so
// one measure replaces the source's scale-4 then scale-16 pair, and the grid walk is new.

/** A frame source that is a pure function of `t`: seeking the same `t` twice gives the same frame. */
export type SeekFrame<F> = (t: number) => F | Promise<F>

/** How visibly two frames differ, as a non-negative number (for example, changed pixels). */
export type FrameDelta<F> = (a: F, b: F) => number

/** The largest change over the whole step and over its halves, quarters and eighths. */
export interface HalvingMeasure {
  full: number
  half: number
  quarter: number
  eighth: number
}

export interface PopFinding {
  /** Index of the grid step `[t, t + step]` that holds the pop. */
  index: number
  t: number
  measure: HalvingMeasure
}

export interface PopReport {
  findings: PopFinding[]
  /** Grid steps whose change passed `threshold` and were re-measured. */
  checked: number
}

export interface PopCheckOptions<F> {
  seek: SeekFrame<F>
  delta: FrameDelta<F>
  start: number
  end: number
  step: number
  /** A grid step whose change is at least this is re-measured; smaller steps are never pops. */
  threshold: number
}

/** Raw RGBA pixels, four bytes per pixel, row by row. */
export interface RgbaFrame {
  width: number
  height: number
  data: Uint8Array
}

/** Counts pixels where any channel differs by more than `tolerance`: a `FrameDelta` for RGBA frames. */
export function changedPixels(a: RgbaFrame, b: RgbaFrame, tolerance = 0): number {
  if (a.width !== b.width || a.height !== b.height) throw new RangeError('changedPixels needs frames of one size')
  let changed = 0
  for (let p = 0; p < a.data.length; p += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a.data[p + c]! - b.data[p + c]!) > tolerance) {
        changed++
        break
      }
    }
  }
  return changed
}

/** Each finer measure must keep more than this share of the coarser one for the change to be a pop. */
export const HALVING_RATIO = 0.6

/** A pop must still change at least this much over an eighth of the step. */
export const MIN_POP_CHANGE = 2

/**
 * Smooth motion halves its per-step change as the step halves; a pop keeps its whole change
 * inside one ever-smaller sub-step.
 */
export function isPop(m: HalvingMeasure): boolean {
  return (
    m.full >= MIN_POP_CHANGE &&
    m.half > HALVING_RATIO * m.full &&
    m.quarter > HALVING_RATIO * m.half &&
    m.eighth > HALVING_RATIO * m.quarter &&
    m.eighth >= MIN_POP_CHANGE
  )
}

/** Measures nine frames spanning one step at eighths: frames[0] is t, frames[8] is t + step. */
export function measureHalving<F>(frames: readonly F[], delta: FrameDelta<F>): HalvingMeasure {
  if (frames.length !== 9) throw new RangeError(`measureHalving needs 9 frames, got ${frames.length}`)
  const largest = (stride: number): number => {
    let max = 0
    for (let j = stride; j <= 8; j += stride) max = Math.max(max, delta(frames[j - stride]!, frames[j]!))
    return max
  }
  return { full: largest(8), half: largest(4), quarter: largest(2), eighth: largest(1) }
}

async function seekEighths<F>(seek: SeekFrame<F>, t: number, step: number, from: F, to: F): Promise<F[]> {
  const frames = [from]
  for (let j = 1; j < 8; j++) frames.push(await seek(t + (step * j) / 8))
  frames.push(to)
  return frames
}

function gridTimes(start: number, end: number, step: number): number[] {
  if (!(step > 0)) throw new RangeError(`step must be positive, got ${step}`)
  const count = Math.floor((end - start) / step + 1e-9)
  return Array.from({ length: count + 1 }, (_, i) => start + i * step)
}

/**
 * Walks a grid of `t` from `start` to `end`. Where a step's change reaches `threshold`, it
 * re-measures the step at h/2, h/4 and h/8 and reports a pop only when the change does not halve.
 */
export async function checkPops<F>(options: PopCheckOptions<F>): Promise<PopReport> {
  const { seek, delta, step, threshold } = options
  const times = gridTimes(options.start, options.end, step)
  const findings: PopFinding[] = []
  let checked = 0
  let previous = await seek(times[0]!)
  for (let i = 1; i < times.length; i++) {
    const current = await seek(times[i]!)
    const t = times[i - 1]!
    if (delta(previous, current) >= threshold) {
      checked++
      const measure = measureHalving(await seekEighths(seek, t, step, previous, current), delta)
      if (isPop(measure)) findings.push({ index: i - 1, t, measure })
    }
    previous = current
  }
  return { findings, checked }
}
