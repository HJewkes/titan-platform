import { chromium, type Browser, type Page } from 'playwright-core'
import type { TitanMotionApi } from './protocol.js'
import { VIRTUAL_TIME_SCRIPT, type VirtualTimeApi } from './virtual-time.js'

declare global {
  interface Window {
    __virtualTime: VirtualTimeApi
    __titanMotion?: TitanMotionApi
  }
}

export interface Viewport {
  width: number
  height: number
}

export interface PageOptions extends Viewport {
  /** Load every declared FontFace before frame 0. Off only to measure what it prevents. */
  preloadFonts?: boolean
}

export interface FontState {
  family: string
  status: string
}

const API_POLL_MS = 10
const API_TIMEOUT_MS = 10_000

export function launch(): Promise<Browser> {
  return chromium.launch({ headless: true })
}

function throwIfPageErrored(errors: readonly Error[], when: string): void {
  const [error] = errors
  if (error) throw new Error(`page error ${when}: ${error.message}`)
}

/** A missing, NaN or non-positive duration would resolve to zero frames, which encodes as a silent success. */
function validDuration(duration: unknown): number {
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) return duration
  throw new Error(`window.__titanMotion.duration must be a positive number of seconds, got ${String(duration)}`)
}

async function waitForMotionApi(page: Page, errors: readonly Error[]): Promise<number> {
  const deadline = Date.now() + API_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfPageErrored(errors, 'while loading')
    const api = await page.evaluate(() => (window.__titanMotion ? { duration: window.__titanMotion.duration } : undefined))
    if (api) return validDuration(api.duration)
    await new Promise((resolve) => setTimeout(resolve, API_POLL_MS))
  }
  throw new Error(`window.__titanMotion did not appear within ${API_TIMEOUT_MS} ms`)
}

/**
 * Loads the page's fonts and waits on document.fonts.ready. The explicit load matters: fonts load
 * lazily on first use, so fonts.ready alone can resolve before a beat that mounts later asks for one.
 * A face that fails to load is left in its `error` status for the caller, which can name it; the
 * rejection itself says only "A network error occurred".
 */
export async function settleFonts(page: Page, preload = true): Promise<FontState[]> {
  return page.evaluate(async (load) => {
    if (load) await Promise.all(Array.from(document.fonts, (face) => face.load().catch(() => face)))
    await document.fonts.ready
    return Array.from(document.fonts, (face) => ({ family: face.family, status: face.status }))
  }, preload)
}

export interface CapturePage {
  page: Page
  /** `__titanMotion.duration` in seconds. */
  duration: number
  fonts: FontState[]
  /** Every uncaught page error, collected from before navigation; empty when the open succeeds. */
  errors: readonly Error[]
}

function assertFontsLoaded(fonts: readonly FontState[]): void {
  const unloaded = fonts.filter((f) => f.status !== 'loaded')
  if (unloaded.length > 0) {
    throw new Error(`fonts not loaded: ${unloaded.map((f) => `${f.family} (${f.status})`).join(', ')}`)
  }
}

/**
 * The pageerror listener attaches before navigation: an error thrown while the page loads, such as a
 * render that throws on mount, leaves a page that still answers seeks and screenshots blank.
 */
export async function openCapturePage(browser: Browser, url: string, options: PageOptions): Promise<CapturePage> {
  const context = await browser.newContext({ viewport: options, deviceScaleFactor: 1 })
  await context.addInitScript({ content: VIRTUAL_TIME_SCRIPT })
  const page = await context.newPage()
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(url, { waitUntil: 'load' })
  const duration = await waitForMotionApi(page, errors)
  const fonts = await settleFonts(page, options.preloadFonts ?? true)
  if (options.preloadFonts !== false) assertFontsLoaded(fonts)
  throwIfPageErrored(errors, 'while loading')
  return { page, duration, fonts, errors }
}

/** One frame: advance virtual time, seek (commits through flushSync), await ready(), screenshot. */
export async function captureFrame(page: Page, t: number): Promise<Buffer> {
  await page.evaluate(async (seconds) => {
    window.__virtualTime.advanceTo(seconds * 1000)
    const motion = window.__titanMotion
    if (!motion) throw new Error('window.__titanMotion is gone')
    motion.seek(seconds)
    await motion.ready()
  }, t)
  return screenshot(page)
}

/** Headless Chromium occasionally answers "Unable to capture screenshot" under load; the frame is already committed. */
async function screenshot(page: Page): Promise<Buffer> {
  try {
    return await page.screenshot({ type: 'png', caret: 'hide' })
  } catch (error) {
    if (!String(error).includes('Unable to capture screenshot')) throw error
    return page.screenshot({ type: 'png', caret: 'hide' })
  }
}
