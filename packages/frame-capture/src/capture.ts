import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
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

/** The unloaded faces, and the font URLs the browser failed to fetch: the rejection itself says only "A network error occurred". */
export class FontLoadError extends Error {
  constructor(readonly faces: readonly FontState[], readonly urls: readonly string[]) {
    const tried = urls.length > 0 ? `; font requests that failed: ${urls.join(', ')}` : ''
    super(`fonts not loaded: ${faces.map((f) => `${f.family} (${f.status})`).join(', ')}${tried}`)
  }
}

const API_POLL_MS = 10
const API_TIMEOUT_MS = 10_000

/**
 * Partial raster re-rasters only the tiles Chromium thinks changed, so a frame reached by a jump keeps
 * tiles from the frame before it. Measured on a seek page: without the flag, a scrambled-order capture
 * differed from a sweep on 77 of 90 frames, by up to 36 levels on fractional edges; with it, 25 of 25 runs
 * matched.
 */
const LAUNCH_ARGS = ['--disable-partial-raster']

export function launch(): Promise<Browser> {
  return chromium.launch({ headless: true, args: LAUNCH_ARGS })
}

/**
 * Runs `use` in `lent` when the caller lends a browser, and leaves it open for the caller's next use; otherwise
 * in a browser launched here and closed after. A lent browser keeps whatever `use` leaves open, so `use` closes
 * its own contexts.
 */
export async function withBrowser<T>(lent: Browser | undefined, use: (browser: Browser) => Promise<T>): Promise<T> {
  if (lent) return use(lent)
  const browser = await launch()
  try {
    return await use(browser)
  } finally {
    await browser.close()
  }
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

function assertFontsLoaded(fonts: readonly FontState[], failedUrls: ReadonlySet<string>): void {
  const unloaded = fonts.filter((f) => f.status !== 'loaded')
  if (unloaded.length > 0) throw new FontLoadError(unloaded, [...failedUrls])
}

/** Every font URL that failed to fetch or answered with an error status, from before navigation. */
function watchFontRequests(page: Page): Set<string> {
  const failed = new Set<string>()
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'font') failed.add(request.url())
  })
  page.on('response', (response) => {
    if (response.request().resourceType() === 'font' && !response.ok()) failed.add(response.url())
  })
  return failed
}

/**
 * The page in a context of its own. A failed open closes that context, so a browser lent across opens is not left
 * holding the pages of the ones that failed.
 */
export async function openCapturePage(browser: Browser, url: string, options: PageOptions): Promise<CapturePage> {
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 })
  try {
    return await loadCapturePage(context, url, options)
  } catch (error) {
    await context.close()
    throw error
  }
}

/** Opens a capture page, runs `use` on it and closes its context however `use` ends. */
export async function withCapturePage<T>(browser: Browser, url: string, options: PageOptions, use: (opened: CapturePage) => Promise<T>): Promise<T> {
  const opened = await openCapturePage(browser, url, options)
  try {
    return await use(opened)
  } finally {
    await opened.page.context().close()
  }
}

/**
 * The pageerror listener attaches before navigation: an error thrown while the page loads, such as a
 * render that throws on mount, leaves a page that still answers seeks and screenshots blank.
 */
async function loadCapturePage(context: BrowserContext, url: string, options: PageOptions): Promise<CapturePage> {
  await context.addInitScript({ content: VIRTUAL_TIME_SCRIPT })
  const page = await context.newPage()
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  const failedFonts = watchFontRequests(page)
  await page.goto(url, { waitUntil: 'load' })
  const duration = await waitForMotionApi(page, errors)
  const fonts = await settleFonts(page, options.preloadFonts ?? true)
  // Anchors the animations the page started while loading at virtual 0, so a chunk that jumps ahead agrees with a sweep.
  await page.evaluate(() => window.__virtualTime.syncAnimations())
  if (options.preloadFonts !== false) assertFontsLoaded(fonts, failedFonts)
  throwIfPageErrored(errors, 'while loading')
  return { page, duration, fonts, errors }
}

/** One frame: advance virtual time, seek (commits through flushSync), await ready(), sync the animations the seek started, screenshot. */
export async function captureFrame(page: Page, t: number): Promise<Buffer> {
  await page.evaluate(async (seconds) => {
    window.__virtualTime.advanceTo(seconds * 1000)
    const motion = window.__titanMotion
    if (!motion) throw new Error('window.__titanMotion is gone')
    motion.seek(seconds)
    await motion.ready()
    window.__virtualTime.syncAnimations()
  }, t)
  return screenshotFrame(page)
}

const sessions = new WeakMap<Page, Promise<CDPSession>>()

function cdpSession(page: Page): Promise<CDPSession> {
  let session = sessions.get(page)
  if (!session) {
    session = page.context().newCDPSession(page)
    sessions.set(page, session)
  }
  return session
}

const HIDE_CARET_ID = '__frame-capture-hide-caret'

/** What `page.screenshot({ caret: 'hide' })` injects around each shot, left in place once instead. */
function hideCaret(id: string): void {
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = '* { caret-color: transparent !important; }'
  document.head.append(style)
}

/**
 * The viewport as a PNG with the caret hidden. `optimizeForSpeed` swaps Chromium's PNG encoder for a faster zlib
 * setting: the pixels are the same and the bytes are the same run to run, but the files are about 2.5x larger. At
 * 1920x1080 it cut a shot from about 42 to 25 ms, which is most of a capture's time.
 */
export async function screenshotFrame(page: Page): Promise<Buffer> {
  await page.evaluate(hideCaret, HIDE_CARET_ID)
  const session = await cdpSession(page)
  const shot = () => session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })
  try {
    return Buffer.from((await shot()).data, 'base64')
  } catch (error) {
    // Headless Chromium occasionally answers "Unable to capture screenshot" under load; the frame is already committed.
    if (!String(error).includes('Unable to capture screenshot')) throw error
    return Buffer.from((await shot()).data, 'base64')
  }
}
