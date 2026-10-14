import type { Browser } from 'playwright-core'
import { captureFrame, launch, openCapturePage, type CapturePage, type PageOptions } from './capture.js'

export interface FramesOptions extends PageOptions {
  url: string
  fps: number
  /** Frame count; defaults to the page's duration times fps. */
  frames?: number
  /**
   * Pages capturing contiguous chunks in parallel. A fixed count renders byte-identically run to run,
   * but a chunk's first frames can differ from a sequential render by a few levels of anti-aliasing.
   */
  workers?: number
}

export interface FramesResult {
  frames: number
  /** `__titanMotion.duration`: the page's own idea of the timeline length. */
  pageDurationS: number
  fonts: CapturePage['fonts']
}

type Sink = (index: number, png: Buffer) => Promise<void>
type Emit = (index: number, png: Buffer) => void

function chunks(frames: number, workers: number): [number, number][] {
  const size = Math.ceil(frames / workers)
  return Array.from({ length: workers }, (_, k): [number, number] => [k * size, Math.min(frames, (k + 1) * size)])
    .filter(([from, to]) => from < to)
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
function captureChunk(options: FramesOptions, [from, to]: [number, number], emit: Emit) {
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
  await Promise.all(chunks(frames, options.workers ?? 1).map((range) => captureChunk(options, range, ordered.emit)))
  await ordered.drained()
  return { frames, pageDurationS: probe.duration, fonts: probe.fonts }
}
