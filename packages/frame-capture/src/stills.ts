import type { Browser } from 'playwright-core'
import { captureFrame, withBrowser, withCapturePage, type PageOptions } from './capture.js'

export interface StillsOptions extends PageOptions {
  url: string
  /** A browser to open the page in; without one, a browser is launched for the stills and closed after. */
  browser?: Browser
}

/**
 * True-size PNG stills of one page at the given seconds: one page, no encode. Virtual time only moves forward, so
 * the moments are taken in time order on one page and returned in the order they were asked for.
 */
export async function stills(options: StillsOptions, atS: readonly number[]): Promise<Buffer[]> {
  const order = atS.map((t, index) => ({ t, index })).sort((a, b) => a.t - b.t)
  return withBrowser(options.browser, (browser) =>
    withCapturePage(browser, options.url, options, async ({ page }) => {
      const shots: Buffer[] = []
      for (const { t, index } of order) shots[index] = await captureFrame(page, t)
      return shots
    }),
  )
}
