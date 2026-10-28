import { captureFrame, openCapturePage } from '@titan-design/frame-capture'
import type { Browser, Page } from 'playwright-core'
import { DEFAULT_OPTIONS, inspectScript, type FrameInspection, type InspectOptions } from './inspect.js'

export interface CueRecord {
  beat: string
  word: string
  nth: number
  atS: number
}

export interface QaSession {
  page: Page
  durationS: number
  cues: CueRecord[]
}

declare global {
  interface Window {
    /** A page that resolves its own cues publishes them here, keyed however it likes. */
    __cueLog?: Map<string, CueRecord>
  }
}

/** Uncaught errors per page. A render that throws (a stage overflow) unmounts the page, and a blank frame inspects clean. */
const pageErrors = new WeakMap<Page, Error[]>()

/** The page's own cue log, when it publishes one as `window.__cueLog`; a page that does not has no cues to offer. */
function pageCues(page: Page): Promise<CueRecord[]> {
  return page.evaluate(() => {
    const log = window.__cueLog
    return log ? [...log.values()] : []
  })
}

/**
 * Opens a capture page for inspection: elementsFromPoint needs pointer events on every element. `cues` are the
 * caller's (a timeline it built); without them the session reads the page's `__cueLog`.
 */
export async function openQaPage(browser: Browser, url: string, viewport = { width: DEFAULT_OPTIONS.W, height: DEFAULT_OPTIONS.H }, cues?: CueRecord[]): Promise<QaSession> {
  const { page, duration } = await openCapturePage(browser, url, viewport)
  const errors: Error[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (e) => errors.push(e))
  await page.addStyleTag({ content: '* { pointer-events: auto !important; }' })
  return { page, durationS: duration, cues: cues ?? (await pageCues(page)) }
}

/** Seeks to `t` with the capture loop's own virtual-time path and inspects the frame; throws if the page threw. */
export async function inspectAt(page: Page, t: number, opts: Partial<InspectOptions> = {}): Promise<FrameInspection> {
  await captureFrame(page, t)
  const [error] = pageErrors.get(page) ?? []
  if (error) throw new Error(`page error at ${t.toFixed(2)} s: ${error.message}`)
  return page.evaluate(inspectScript({ ...DEFAULT_OPTIONS, ...opts }))
}
