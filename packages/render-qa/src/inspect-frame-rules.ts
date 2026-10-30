/**
 * Contrast and the frame rules of the in-page inspector: two chromes at once (a beat-boundary overprint), stage
 * content under a chrome band, a later compare card filled before an earlier one, a problem drawn in the success
 * tone, a card row that repeats its title or shows a bare number, two unrelated labels side by side close enough to
 * read as one phrase, and sibling stat values that do not sit level. Steps run in the page; see inspect-geometry.ts.
 */
import type { Inspector, PartialSteps, Rgb, Rgba, Run } from './inspect-types.js'

function pageBg(h: Inspector): Rgb {
  const body = h.rgba(getComputedStyle(document.body).backgroundColor)
  const [r, g, b] = body[3] > 0.05 ? body : h.rgba(getComputedStyle(document.documentElement).backgroundColor)
  return [r, g, b]
}

function blend(_h: Inspector, c: Rgba, op: number, under: Rgb): Rgb {
  const k = c[3] * op
  return [c[0] * k + under[0] * (1 - k), c[1] * k + under[1] * (1 - k), c[2] * k + under[2] * (1 - k)]
}

function bgBehind(h: Inspector, el: Element): Rgb {
  for (let e: Element | null = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e instanceof SVGElement) continue
    const c = h.rgba(getComputedStyle(e).backgroundColor)
    if (c[3] > 0.05) return h.blend(c, h.opacity(e), h.pageBg())
  }
  return h.pageBg()
}

function lum(_h: Inspector, c: Rgb): number {
  const linear = (v: number) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
}

function hex(_h: Inspector, c: Rgb): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

function checkContrast(h: Inspector, run: Run): void {
  if (run.el.closest('[data-qa-context]')) return
  const s = getComputedStyle(run.el)
  const bg = h.bgBehind(run.el)
  const fg = h.blend(h.rgba(run.el instanceof SVGElement ? s.fill : s.color), run.op, bg)
  const [text, ground] = [h.lum(fg), h.lum(bg)]
  const ratio = (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05)
  const need = run.px >= h.opts.largePx ? h.opts.largeContrast : h.opts.minContrast
  if (ratio >= need) return
  const colours = { need, fg: h.hex(fg), bg: h.hex(bg) }
  h.add('low-contrast', run.el, { text: run.text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, ...colours, op: Math.round(run.op * 100) / 100, px: run.px, rect: h.r4(run.box) })
}

/** Two chromes at once: the outgoing beat's headline and chapter line over the incoming one's. */
function checkDoubleChrome(h: Inspector): void {
  const shownChromes = [...document.querySelectorAll(h.opts.chromeSelector)].filter((el) => h.opacity(el) > 0.1)
  const [, second] = shownChromes
  if (second) {
    h.add('double-chrome', second, { text: shownChromes.map((el) => h.textOf(el).slice(0, 30)).join(' | '), rect: { x: 0, y: 0, w: h.opts.W, h: h.opts.H } })
  }
}

/** Stage text whose visible ink reaches into a chrome band (a camera move carrying the map under the headline). */
function checkUnderChrome(h: Inspector, runs: Run[]): void {
  const bands = [...document.querySelectorAll(h.opts.bandSelector)].map((b) => h.asR(b.getBoundingClientRect()))
  for (const run of runs) {
    if (run.el.closest(h.opts.chromeSelector)) continue
    const ink = h.clipped(run.el, run.box)
    const hit = ink && bands.map((b) => h.inter(h.shrink(ink, 1), b)).find((o) => o && o.w * o.h >= 40)
    if (ink && hit) h.add('under-chrome', run.el, { text: run.text.slice(0, 40), rect: h.r4(ink) })
  }
}

/** A compare whose later card shows rows while the first card shows none: it reads right to left. */
function checkFillOrder(h: Inspector): void {
  for (const cmp of document.querySelectorAll('[data-qa-order]')) {
    const filled = [...cmp.querySelectorAll(':scope > *')].map((card) => [...card.querySelectorAll(cmp.getAttribute('data-qa-order') ?? '')].some((el) => h.shown(el)))
    const late = filled.findIndex((f, i) => f && filled.slice(0, i).some((g) => !g))
    if (late > 0) h.add('fill-order', cmp, { text: h.textOf(cmp).slice(0, 40), card: late })
  }
}

/** A mark or pill drawn in the success tone while its state, or its words, say it is a problem. */
function checkTone(h: Inspector): void {
  const problemWords = /\b(fail(ed|s)?|off|blocked|stalled|refused|error|broken)\b/i
  const success = h.rgba(getComputedStyle(document.documentElement).getPropertyValue('--color-status-success').trim() || 'rgba(0,0,0,0)')
  if (success[3] === 0) return
  const same = (c: Rgba) => Math.abs(c[0] - success[0]) < 4 && Math.abs(c[1] - success[1]) < 4 && Math.abs(c[2] - success[2]) < 4
  for (const el of document.querySelectorAll('[data-mark], [data-state]')) {
    if (h.opacity(el) <= 0.1) continue
    const glyph = el.querySelector('[data-qa-glyph]') ?? el
    const problem = ['problem', 'risk'].includes(el.getAttribute('data-mark') ?? el.getAttribute('data-state') ?? '') || problemWords.test(h.textOf(el))
    if (problem && same(h.rgba(getComputedStyle(glyph).color))) h.add('tone-mismatch', el, { text: h.textOf(el).slice(0, 40) })
  }
}

/** Card rows that repeat the card's title ("Alpha" / "Alpha: 0 items") or show numbers with no word. */
function checkCardText(h: Inspector): void {
  for (const title of document.querySelectorAll('[data-qa-title]')) {
    const name = h.textOf(title).toLowerCase()
    for (const row of [...(title.parentElement?.children ?? [])].filter((r) => r !== title && h.opacity(r) > 0.1)) {
      const text = h.textOf(row)
      if (name && text.toLowerCase().startsWith(name)) h.add('title-repeat', row, { text: text.slice(0, 40), title: name })
      else if (/\d/.test(text) && !/[a-z]{2,}/i.test(text)) h.add('unlabelled-number', row, { text: text.slice(0, 40) })
    }
  }
}

/**
 * A line of each run sharing a row (their ink bands overlap at all), their ink closer than one em, reads as one
 * phrase. Ink, not boxes: a pill can sit 9 px from a label while its words sit 35 px away. Runs of one row or card
 * (a common ancestor within two levels, like a tick and its row's text) are one label, and the em is capped at twice
 * the type floor.
 */
function checkAdjacent(h: Inspector, runs: Run[]): void {
  const labels = runs.filter((r) => !r.el.closest(h.opts.chromeSelector))
  const oneUnit = (a: Element, b: Element) => [a, a.parentElement, a.parentElement?.parentElement].some((e) => e?.contains(b))
  const near = (a: Run, b: Run) => a.lines.flatMap((la) => b.lines.map((lb) => {
    const rowShare = Math.min(la.bottom, lb.bottom) - Math.max(la.top, lb.top)
    const gap = Math.max(lb.left - la.right, la.left - lb.right)
    return rowShare > 0 && gap >= 0 && gap < Math.min(a.px, b.px, 2 * h.opts.floorPx) ? { gap, at: h.unionRect([la, lb]) } : null
  })).find(Boolean)
  for (const [i, a] of labels.entries()) for (const b of labels.slice(i + 1)) {
    if (oneUnit(a.el, b.el) || oneUnit(b.el, a.el)) continue
    const hit = near(a, b)
    if (hit) h.add('label-adjacent', a.el, { text: a.text.slice(0, 40), other: b.text.slice(0, 40), otherEl: h.describe(b.el), gapPx: Math.round(hit.gap), rect: h.r4(hit.at) })
  }
}

/** Sibling cards' values that do not sit level: a wrapped label pushed one number down. */
function checkLevel(h: Inspector): void {
  for (const row of document.querySelectorAll('[data-qa-level]')) {
    const tops = [...row.querySelectorAll(row.getAttribute('data-qa-level') ?? '')].filter((v) => h.opacity(v) > 0.1).map((v) => v.getBoundingClientRect().top)
    if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 4) h.add('misaligned', row, { text: h.textOf(row).slice(0, 40), dyPx: Math.round(Math.max(...tops) - Math.min(...tops)) })
  }
}

export const FRAME_RULE_STEPS: PartialSteps<'pageBg' | 'blend' | 'bgBehind' | 'lum' | 'hex' | 'checkContrast' | 'checkDoubleChrome' | 'checkUnderChrome'
  | 'checkFillOrder' | 'checkTone' | 'checkCardText' | 'checkAdjacent' | 'checkLevel'> = {
  pageBg, blend, bgBehind, lum, hex, checkContrast, checkDoubleChrome, checkUnderChrome, checkFillOrder, checkTone, checkCardText, checkAdjacent, checkLevel,
}
