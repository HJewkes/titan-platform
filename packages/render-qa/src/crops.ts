import { mkdir, rm } from 'node:fs/promises'
import { captureFrame } from '@titan-design/frame-capture'
import type { Browser, Page } from 'playwright-core'
import type { HeldFinding } from './held.js'
import type { InspectOptions } from './inspect.js'
import { openQaPage } from './session.js'

const CROP_PAD_PX = 80
/** Crops per finding kind: a page with 1,400 small-text errors still gets a look at every other kind. */
export const MAX_CROPS_PER_KIND = 8

export interface CroppedFinding extends HeldFinding {
  /** The crop's file name inside the crop directory; absent past the per-kind cap. */
  crop?: string
}

/**
 * The padded rect clipped to the frame. A rect wholly past an edge (an element painted off-frame) has no on-frame
 * area, so it gets the band of padding width at that edge rather than an empty clip, which playwright refuses.
 */
function frameClip({ x, y, w, h }: { x: number; y: number; w: number; h: number }, { W, H }: InspectOptions) {
  const x0 = Math.max(0, Math.min(x - CROP_PAD_PX, W - CROP_PAD_PX))
  const y0 = Math.max(0, Math.min(y - CROP_PAD_PX, H - CROP_PAD_PX))
  const x1 = Math.min(W, Math.max(x + w + CROP_PAD_PX, CROP_PAD_PX))
  const y1 = Math.min(H, Math.max(y + h + CROP_PAD_PX, CROP_PAD_PX))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Draws the finding's rectangle on the page, screenshots a padded clip around it, and removes the box. */
async function annotatedCrop(page: Page, held: HeldFinding, path: string, opts: InspectOptions): Promise<void> {
  const { x, y, w, h } = held.finding.at
  const clip = frameClip(held.finding.at, opts)
  await page.evaluate(({ x, y, w, h, label }) => {
    const box = document.createElement('div')
    box.id = '__qa-annotation'
    Object.assign(box.style, { position: 'fixed', left: `${x - 3}px`, top: `${y - 3}px`, width: `${w + 6}px`, height: `${h + 6}px`,
      outline: '3px solid #ff2d55', zIndex: '2147483647', pointerEvents: 'none', font: '700 20px sans-serif', color: '#ff2d55' })
    box.textContent = label
    document.body.append(box)
  }, { x, y, w, h, label: held.kind })
  await page.screenshot({ path, clip })
  await page.evaluate(() => document.getElementById('__qa-annotation')?.remove())
}

/** The first `MAX_CROPS_PER_KIND` errors of each kind, with their index, in time order. */
function wantedCrops(errors: readonly CroppedFinding[]): { held: CroppedFinding; i: number }[] {
  const seen = new Map<string, number>()
  const cropped = errors.map((held, i) => ({ held, i })).filter(({ held }) => {
    const n = seen.get(held.kind) ?? 0
    seen.set(held.kind, n + 1)
    return n < MAX_CROPS_PER_KIND
  })
  return cropped.sort((a, b) => (a.held.ts[0] ?? 0) - (b.held.ts[0] ?? 0))
}

/**
 * Writes an annotated crop per held error into `dir`, emptied first, and sets each one's `crop`. Virtual time only
 * moves forward, so the crops come from a fresh page of the same browser, in time order.
 */
export async function writeCrops(browser: Browser, url: string, errors: CroppedFinding[], dir: string, opts: InspectOptions): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const { page } = await openQaPage(browser, url, { width: opts.W, height: opts.H }, [])
  try {
    for (const { held, i } of wantedCrops(errors)) {
      const t = held.ts[0] ?? 0
      await captureFrame(page, t)
      const name = `${String(i).padStart(3, '0')}-${held.kind}-${held.beat}-${t.toFixed(1)}s.png`
      await annotatedCrop(page, held, `${dir}/${name}`, opts)
      held.crop = name
    }
  } finally {
    await page.context().close()
  }
}
