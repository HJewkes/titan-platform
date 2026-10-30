/**
 * Layout checks of the in-page inspector: overflow, crowding, per-run text rules, wraps, flex wraps, anchors, edge
 * labels and dropped labels. Steps run in the page; see inspect-geometry.ts for the serialisation rules.
 */
import type { Inspector, Item, PartialSteps, Rect, Run } from './inspect-types.js'

/**
 * Content taller or wider than its own box. Scroll sizes flag it; the ink of its text and the boxes inside it confirm
 * it, so a line box taller than a chip whose words sit inside it (3 px on a rail chip) is not an overflow.
 */
function checkOverflow(h: Inspector, boxes: Item[], runs: Run[]): void {
  for (const { el } of boxes) {
    if (el.scrollWidth - el.clientWidth <= 1 && el.scrollHeight - el.clientHeight <= 1) continue
    const inks = [...runs.filter((r) => el.contains(r.el)).map((r) => r.box), ...boxes.filter((b) => b.el !== el && el.contains(b.el)).map((b) => b.r)]
    if (!inks.length) continue
    const [ink, inner] = [h.unionRect(inks), h.innerOf(el)]
    const dx = Math.round(Math.max(inner.left - ink.left, ink.right - inner.right)), dy = Math.round(Math.max(inner.top - ink.top, ink.bottom - inner.bottom))
    if (dx > 1 || dy > 1) h.add('content-overflow', el, { text: h.textOf(el).slice(0, 40), dx, dy, overflow: getComputedStyle(el).overflow })
  }
}

/** Unrelated text and labelled boxes closer than `clearPx` without touching: crowding, not yet collision. */
function checkCrowding(h: Inspector, runs: Run[], boxes: Item[]): void {
  const { clearPx, chromeSelector } = h.opts
  const items = [...runs.map((r) => ({ el: r.el, rs: r.lines, text: r.text })),
    ...boxes.filter((b) => h.textOf(b.el)).map((b) => ({ el: b.el, rs: [b.r], text: h.textOf(b.el) }))]
  const grow = (r: Rect) => h.rect(r.left - clearPx, r.top - clearPx, r.right + clearPx, r.bottom + clearPx)
  for (const [i, a] of items.entries()) for (const b of items.slice(i + 1)) {
    if (h.related(a.el, b.el) || a.el.closest(chromeSelector) || b.el.closest(chromeSelector)) continue
    const touching = a.rs.some((ra) => b.rs.some((rb) => h.inter(ra, rb)))
    const near = a.rs.some((ra) => b.rs.some((rb) => h.inter(grow(ra), rb)))
    if (near && !touching) h.add('crowding', a.el, { text: a.text.slice(0, 40), other: b.text.slice(0, 40), otherEl: h.describe(b.el) })
  }
}

function checkRuns(h: Inspector, runs: Run[]): void {
  const { W, H, floorPx } = h.opts
  for (const run of runs) {
    if (run.px < floorPx) h.add('small-text', run.el, { text: run.text.slice(0, 40), px: run.px, rect: h.r4(run.box) })
    if (run.text.includes('…')) h.add('ellipsis', run.el, { text: run.text.slice(-40), rect: h.r4(run.box) })
    const ink = h.inFlight(run.el) ? null : h.clipped(run.el, run.box)
    if (ink && (ink.left < -1 || ink.top < -1 || ink.right > W + 1 || ink.bottom > H + 1)) h.add('off-frame', run.el, { text: run.text.slice(0, 40), rect: h.r4(ink) })
    h.checkEscape(run)
    h.checkContrast(run)
  }
}

function checkEscape(h: Inspector, run: Run): void {
  let box: Element | null = run.el
  while (box && !(box instanceof SVGElement) && box !== document.body && !h.isBox(box)) box = box.parentElement
  if (!box || box instanceof SVGElement || box === document.body) return
  const inner = h.innerOf(box)
  const out = Math.max(inner.left - run.box.left, inner.top - run.box.top, run.box.right - inner.right, run.box.bottom - inner.bottom)
  if (out > 1) h.add('escapes-box', run.el, { text: run.text.slice(0, 40), box: h.describe(box), byPx: Math.round(out), rect: h.r4(run.box) })
}

/** Headings, titles and labels that break onto more than one line; orphan when the last line is one short word. */
function checkWraps(h: Inspector): void {
  const els = [...document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="label"], [class*="headline"], [class*="row"], [class*="step"]')]
    .filter((el) => !(el instanceof SVGElement) && h.opacity(el) > 0.1 && h.textOf(el) && !h.decor(el))
  for (const el of els) {
    if (els.some((o) => o !== el && el.contains(o))) continue
    const display = getComputedStyle(el).display
    if (display.includes('flex') || display.includes('grid')) continue
    const range = document.createRange()
    range.selectNodeContents(el)
    const lines = h.clusterLines([...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1))
    if (lines.length < 2) continue
    const widest = Math.max(...lines.map((l) => l.width))
    h.add('wrap', el, { text: h.textOf(el).slice(0, 60), lines: lines.length, orphan: (lines.at(-1)?.width ?? widest) < widest * 0.3 })
  }
}

/** Rects grouped into visual lines: a rect joins a line when its vertical centre is within half a line of it. */
function clusterLines(h: Inspector, rects: DOMRect[]): Rect[] {
  const lines: Rect[] = []
  for (const r of [...rects].sort((a, b) => a.top - b.top)) {
    const mid = (r.top + r.bottom) / 2
    const line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - mid) < Math.max(l.height, r.height) / 2)
    if (line) Object.assign(line, h.unionRect([line, h.asR(r)]))
    else lines.push(h.asR(r))
  }
  return lines
}

/** Flex items, looking through `display: contents` wrappers. */
function flexItems(h: Inspector, el: Element): Element[] {
  return [...el.children].flatMap((k) => (getComputedStyle(k).display === 'contents' ? h.flexItems(k) : [k]))
}

function checkFlexWrap(h: Inspector): void {
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    if (!s.display.includes('flex') || s.flexWrap === 'nowrap' || h.opacity(el) <= 0.1) continue
    const kids = h.flexItems(el).filter((k) => h.opacity(k) > 0.1).map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0)
    const rows = new Set(kids.map((r) => Math.round(r.top / 8)))
    if (rows.size > 1) h.add('flex-wrap', el, { text: h.textOf(el).slice(0, 60), rows: rows.size, items: kids.length })
  }
}

/** Elements that declare the point they belong to: centred on it within `anchorTolPx`, per axis present. */
function checkAnchors(h: Inspector): void {
  for (const el of document.querySelectorAll('[data-anchor-x], [data-anchor-y]')) {
    if (h.opacity(el) <= 0.1) continue
    const r = el.getBoundingClientRect()
    const ax = el.getAttribute('data-anchor-x'), ay = el.getAttribute('data-anchor-y')
    const dx = ax === null ? 0 : (r.left + r.right) / 2 - Number(ax)
    const dy = ay === null ? 0 : (r.top + r.bottom) / 2 - Number(ay)
    if (Math.abs(dx) > h.opts.anchorTolPx || Math.abs(dy) > h.opts.anchorTolPx) {
      h.add('anchor-offset', el, { text: h.textOf(el).slice(0, 40), dx: Math.round(dx), dy: Math.round(dy) })
    }
  }
}

/** A `data-edge-label` box must sit within `edgeLabelReachPx` of its `data-edge` line, or it reads as a neighbour's. */
function checkEdgeLabelReach(h: Inspector): void {
  for (const el of document.querySelectorAll('[data-edge-label]')) {
    const id = el.getAttribute('data-edge-label') ?? ''
    const path = document.querySelector<SVGGeometryElement>(`[data-edge="${CSS.escape(id)}"] path`)
    const m = path?.getScreenCTM()
    if (!path || !m || h.opacity(el) <= 0.1 || h.inFlight(el)) continue
    const r = el.getBoundingClientRect()
    let gap = Infinity
    for (let d = 0, total = path.getTotalLength(); d <= total; d += 2) {
      const p = path.getPointAtLength(d)
      const [x, y] = [m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f]
      gap = Math.min(gap, Math.hypot(Math.max(0, r.left - x, x - r.right), Math.max(0, r.top - y, y - r.bottom)))
    }
    if (gap > h.opts.edgeLabelReachPx) h.add('edge-label-far', el, { text: h.textOf(el).slice(0, 40), edge: id, gapPx: Math.round(gap) })
  }
}

/** A dropped label is never drawn, so the beat is missing text: each listed id is a finding. */
function checkDroppedLabels(h: Inspector): void {
  for (const el of document.querySelectorAll('[data-labels-dropped-ids]')) {
    for (const id of (el.getAttribute('data-labels-dropped-ids') ?? '').split(/\s+/).filter(Boolean)) {
      h.add('label-dropped', el, { text: id, rect: { x: 0, y: 0, w: h.opts.W, h: h.opts.H } })
    }
  }
}

export const LAYOUT_STEPS: PartialSteps<'checkOverflow' | 'checkCrowding' | 'checkRuns' | 'checkEscape' | 'checkWraps' | 'clusterLines' | 'flexItems'
  | 'checkFlexWrap' | 'checkAnchors' | 'checkEdgeLabelReach' | 'checkDroppedLabels'> = {
  checkOverflow, checkCrowding, checkRuns, checkEscape, checkWraps, clusterLines, flexItems, checkFlexWrap, checkAnchors, checkEdgeLabelReach,
  checkDroppedLabels,
}
