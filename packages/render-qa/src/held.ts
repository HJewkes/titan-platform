/**
 * Which findings gate. HyperFrames' persistence rule: a finding seen in two consecutive samples of a beat, or
 * at its settled (end) moment, is a held error. One transient sample, such as an entrance fade passing through
 * a cue moment, is info. Kinds the plan did not choose to gate are always info. Late-fill is a property of the
 * beat's timing, so one sample of it gates.
 */
import type { Finding } from './inspect.js'
import type { MomentKind } from './moments.js'

export const ERROR_KINDS = ['text-overlap', 'text-box', 'box-overlap', 'occluded', 'edge-crossing', 'off-frame', 'content-overflow',
  'small-text', 'low-contrast', 'wrap', 'flex-wrap', 'anchor-offset', 'label-dropped', 'edge-label-far', 'late-fill',
  'double-chrome', 'under-chrome', 'fill-order', 'tone-mismatch', 'title-repeat', 'unlabelled-number', 'label-adjacent', 'misaligned'] as const

/**
 * Kinds that gate on one sample: a beat-boundary overprint lasts one frame and a camera move under the headline
 * about a second, so neither ever holds over two samples. They are also the only kinds read at the boundary and
 * entry moments, where every other finding is an entrance in flight.
 */
export const FRAME_KINDS: readonly string[] = ['double-chrome', 'under-chrome']
const TRANSIT_MOMENTS: readonly MomentKind[] = ['start', 'enter']

/** Past this share of a non-map beat, a stage with at most one content text run and cues still to come is empty. */
export const LATE_FILL_SHARE = 0.35
/** A beat that ever shows this many content runs is a map or a full stage, not a headline waiting for its list. */
const FULL_STAGE_RUNS = 10

export interface SampledFrame {
  beat: string
  local: number
  t: number
  kind: MomentKind
  contentRuns: number
  findings: Finding[]
}

export interface HeldFinding {
  kind: string
  beat: string
  finding: Finding
  /** Seconds from the video start of every sample the finding appeared in. */
  ts: number[]
  samples: number
  /** Why it gates: seen in consecutive samples, or at the settled moment. */
  reason: 'held' | 'settled' | 'timing' | 'frame' | 'transient' | 'info-kind'
}

export interface Held {
  errors: HeldFinding[]
  info: HeldFinding[]
}

export interface ClassifyOptions {
  /** Kinds that may gate. Defaults to every kind the mechanism knows; which of them gate is the caller's policy. */
  gate?: readonly string[]
}

export const isErrorKind = (f: Finding, gate: readonly string[] = ERROR_KINDS): boolean =>
  gate.includes(f.kind) && (f.kind !== 'wrap' || f.orphan === true)

const keyOf = (f: Finding) => [f.kind, f.el, f.text, f.twin, f.other, f.otherEl, f.edge, f.by].join('|')

/** Adds `late-fill` findings: a beat that is still nearly empty well into its length with cues still to come. */
export function addLateFill(frames: readonly SampledFrame[], cues: readonly { beat: string; atS: number }[], durations: ReadonlyMap<string, number>): void {
  const beats = new Set(frames.map((f) => f.beat))
  for (const beat of beats) {
    const own = frames.filter((f) => f.beat === beat)
    if (Math.max(...own.map((f) => f.contentRuns)) >= FULL_STAGE_RUNS) continue
    for (const f of own) {
      const pending = cues.filter((c) => c.beat === beat && c.atS > f.local).length
      if (f.local >= LATE_FILL_SHARE * (durations.get(beat) ?? Infinity) && f.contentRuns <= 1 && pending > 0) {
        f.findings.push({ kind: 'late-fill', el: 'stage', text: `${f.contentRuns} runs, ${pending} cues pending`, at: { x: 0, y: 0, w: 1920, h: 1080 } })
      }
    }
  }
}

interface Group { held: HeldFinding; run: number; best: number; atEnd: boolean }

/** One group per beat and finding key, with its longest run of consecutive samples and whether it reached the end moment. */
function groupFindings(frames: readonly SampledFrame[]): Group[] {
  const groups = new Map<string, Group>()
  const previous = new Map<string, Set<string>>()
  for (const frame of frames) {
    const before = previous.get(frame.beat) ?? new Set<string>()
    const now = new Set<string>()
    for (const finding of frame.findings) {
      if (TRANSIT_MOMENTS.includes(frame.kind) && !FRAME_KINDS.includes(finding.kind)) continue
      const key = keyOf(finding)
      if (now.has(key)) continue
      now.add(key)
      const id = `${frame.beat}|${key}`
      const g = groups.get(id) ?? { held: { kind: finding.kind, beat: frame.beat, finding, ts: [], samples: 0, reason: 'transient' }, run: 0, best: 0, atEnd: false }
      g.held.ts.push(frame.t)
      g.held.samples += 1
      g.run = before.has(key) ? g.run + 1 : 1
      g.best = Math.max(g.best, g.run)
      g.atEnd ||= frame.kind === 'end'
      groups.set(id, g)
    }
    previous.set(frame.beat, now)
  }
  return [...groups.values()]
}

/**
 * Drops the parked findings (an element whose painted rect has no area on the frame) of an element that paints on
 * frame at a later sample of its beat: it waits for its cue, then enters. One that stays parked to the beat's end
 * keeps its finding, and a partly off-frame sample is never parked, so it is judged as before. The inspector sees
 * one sample, so only here, over the beat's samples, can an entrance be told from a card that never arrives.
 */
function excuseEntrances(frames: readonly SampledFrame[]): SampledFrame[] {
  const parkedKeys = (f: SampledFrame) => new Set(f.findings.filter((x) => x.parked).map(keyOf))
  return frames.map((frame, i) => {
    const later = frames.slice(i + 1).filter((f) => f.beat === frame.beat).map(parkedKeys)
    const enters = (x: Finding) => later.some((keys) => !keys.has(keyOf(x)))
    return { ...frame, findings: frame.findings.filter((x) => !(x.parked && enters(x))) }
  })
}

/** Frames in time order; consecutive means adjacent samples of the same beat. */
export function classify(frames: readonly SampledFrame[], options: ClassifyOptions = {}): Held {
  const out: Held = { errors: [], info: [] }
  for (const { held: g, best, atEnd } of groupFindings(excuseEntrances(frames))) {
    if (!isErrorKind(g.finding, options.gate)) out.info.push({ ...g, reason: 'info-kind' })
    else if (g.kind === 'late-fill') out.errors.push({ ...g, reason: 'timing' })
    else if (FRAME_KINDS.includes(g.kind)) out.errors.push({ ...g, reason: 'frame' })
    else if (best >= 2) out.errors.push({ ...g, reason: 'held' })
    else if (atEnd) out.errors.push({ ...g, reason: 'settled' })
    else out.info.push({ ...g, reason: 'transient' })
  }
  return out
}

export function countByKind(items: readonly HeldFinding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1
  return counts
}
