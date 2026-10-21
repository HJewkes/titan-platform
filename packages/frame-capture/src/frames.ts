import type { Browser } from 'playwright-core'
import { captureFrame, launch, openCapturePage, type CapturePage, type PageOptions } from './capture.js'

export interface FramesOptions extends PageOptions {
  url: string
  fps: number
  /** Frame count; defaults to the page's duration times fps. */
  frames?: number
  /**
   * Pages capturing contiguous chunks in parallel. A fixed count renders byte-identically run to run.
   * Without `beatStartsS`, a chunk can start mid-beat, and its first frames can then differ from a
   * sequential render by a few levels of anti-aliasing.
   */
  workers?: number
  /**
   * Seconds at which the page lays out a fresh scene. Chunks then start only on these frames, so any
   * worker count renders the same frames as one worker; fewer chunks than `workers` run when there are
   * fewer beats.
   */
  beatStartsS?: readonly number[]
}

export interface FramesResult {
  frames: number
  /** `__titanMotion.duration`: the page's own idea of the timeline length. */
  pageDurationS: number
  fonts: CapturePage['fonts']
}

type Sink = (index: number, png: Buffer) => Promise<void>
type Emit = (index: number, png: Buffer) => void

type Range = [from: number, to: number]

/** Float slack so a beat at 0.5 s and 30 fps lands on frame 15, not 16. */
const FRAME_EPSILON = 1e-6

function chunksByCount(frames: number, workers: number): Range[] {
  const size = Math.ceil(frames / workers)
  return Array.from({ length: workers }, (_, k): Range => [k * size, Math.min(frames, (k + 1) * size)])
    .filter(([from, to]) => from < to)
}

/** The first frame of each beat: the first frame whose time is at or after the beat's start. */
function beatFrames(beatStartsS: readonly number[], fps: number, frames: number): number[] {
  const starts = beatStartsS.map((s) => {
    if (!Number.isFinite(s) || s < 0) throw new Error(`beatStartsS must be finite seconds >= 0, got ${s}`)
    return Math.ceil(s * fps - FRAME_EPSILON)
  })
  return [...new Set([0, ...starts])].filter((f) => f < frames).sort((a, b) => a - b)
}

/**
 * Packs whole beats into at most `workers` chunks: each cut goes on the beat start nearest an even split,
 * so the chunks balance as well as the beats allow.
 */
export function beatChunks(starts: readonly number[], frames: number, workers: number): Range[] {
  const cuts = new Set([0])
  for (let k = 1; k < workers; k++) {
    const ideal = (k * frames) / workers
    const nearest = starts.reduce((best, f) => (Math.abs(f - ideal) < Math.abs(best - ideal) ? f : best), 0)
    cuts.add(nearest)
  }
  const sorted = [...cuts].sort((a, b) => a - b)
  return sorted.map((from, k): Range => [from, sorted[k + 1] ?? frames]).filter(([from, to]) => from < to)
}

function chunks(options: FramesOptions, frames: number): Range[] {
  const workers = options.workers ?? 1
  if (!options.beatStartsS) return chunksByCount(frames, workers)
  return beatChunks(beatFrames(options.beatStartsS, options.fps, frames), frames, workers)
}

/**
 * Hands frames to `sink` strictly in index order however the workers interleave. Out-of-order frames
 * wait in memory; `drained()` settles once everything handed in has reached the sink.
 */
function orderedSink(sink: Sink) {
  const waiting = new Map<number, Buffer>()
  let next = 0
  let draining = Promise.resolve()
  const drain = async () => {
    for (let buf = waiting.get(next); buf; buf = waiting.get(next)) {
      waiting.delete(next)
      await sink(next++, buf)
    }
  }
  return {
    emit(index: number, png: Buffer) {
      waiting.set(index, png)
      draining = draining.then(drain)
    },
    drained: () => draining,
  }
}

async function withBrowser<T>(use: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launch()
  try {
    return await use(browser)
  } finally {
    await browser.close()
  }
}

/**
 * One browser per chunk, not one page per chunk in a shared browser: screenshots encode in the browser
 * process, so a shared browser stops scaling at about 60 fps. A page error rejects the chunk
 * before its frame is emitted: a render that throws unmounts the page, and every frame after it would encode black.
 */
function captureChunk(options: FramesOptions, [from, to]: Range, emit: Emit) {
  return withBrowser(async (browser) => {
    const { page, errors } = await openCapturePage(browser, options.url, options)
    for (let i = from; i < to; i++) {
      const png = await captureFrame(page, i / options.fps)
      const [error] = errors
      if (error) throw new Error(`page error at frame ${i} (${(i / options.fps).toFixed(2)} s): ${error.message}`)
      emit(i, png)
    }
  })
}

export async function captureFrames(options: FramesOptions, sink: Sink): Promise<FramesResult> {
  const probe = await withBrowser((browser) => openCapturePage(browser, options.url, options))
  const frames = options.frames ?? Math.round(probe.duration * options.fps)
  const ordered = orderedSink(sink)
  await Promise.all(chunks(options, frames).map((range) => captureChunk(options, range, ordered.emit)))
  await ordered.drained()
  return { frames, pageDurationS: probe.duration, fonts: probe.fonts }
}
