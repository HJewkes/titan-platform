/**
 * Text runs, occlusion and the overlap checks of the in-page inspector. Text is measured by its ink band (the line box
 * shrunk to the font's em height), not its line box, so a big stat value's tall line box does not "overlap" the label
 * above it. Steps run in the page; see inspect-geometry.ts for the serialisation rules.
 */
import type { Inspector, Item, PartialSteps, Rect, Run } from './inspect-types.js'

function ink(h: Inspector, line: Rect, px: number): Rect {
  const pad = Math.max(0, (line.height - px * 0.8) / 2)
  return h.rect(line.left, line.top + pad, line.right, line.bottom - pad)
}

function mergeLines(h: Inspector, rects: DOMRect[]): Rect[] {
  const byTop = new Map<number, Rect>()
  for (const r of rects) {
    const key = Math.round(r.top / 4)
    const prior = byTop.get(key)
    byTop.set(key, prior ? h.unionRect([prior, h.asR(r)]) : h.asR(r))
  }
  return [...byTop.values()]
}

function textRuns(h: Inspector): Run[] {
  const runs: Run[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim()
    const el = node.parentElement
    if (!text || !el || h.decor(el)) continue
    const op = h.opacity(el)
    if (op <= 0.1) continue
    const px = parseFloat(getComputedStyle(el).fontSize)
    const range = document.createRange()
    range.selectNodeContents(node)
    const lines = h.mergeLines([...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)).map((l) => h.ink(l, px))
    if (lines.length) runs.push({ node, el, text, op, px, lines, box: h.unionRect(lines) })
  }
  return runs
}

function coverAt(h: Inspector, el: Element, x: number, y: number): Element | null {
  if (x < 0 || y < 0 || x >= h.opts.W || y >= h.opts.H) return null
  for (const top of document.elementsFromPoint(x, y)) {
    if (h.related(top, el)) return null
    if (h.decor(top)) continue
    if (h.isPainted(top) && h.opacity(top) > 0.1) return top
  }
  return null
}

/** Text fully covered by a painted element is reported once as occluded and then left out of the other checks. */
function markOccluded(h: Inspector, runs: Run[]): void {
  for (const run of runs) {
    const pts = run.lines.flatMap((l) => [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9].map((f) => [l.left + l.width * f, (l.top + l.bottom) / 2] as const))
    const covers = pts.map(([x, y]) => h.coverAt(run.el, x, y))
    const by = covers.find(Boolean)
    run.hidden = covers.every(Boolean)
    if (by) h.add('occluded', run.el, { text: run.text.slice(0, 60), by: h.describe(by), byText: h.textOf(by).slice(0, 40), full: run.hidden, rect: h.r4(run.box) })
  }
}

function checkTextOverlap(h: Inspector, runs: Run[]): void {
  for (const [i, a] of runs.entries()) for (const b of runs.slice(i + 1)) {
    if (h.related(a.el, b.el)) continue
    const hit = a.lines.flatMap((la) => b.lines.map((lb) => ({ la, o: h.inter(h.shrink(la, 1), h.shrink(lb, 1)) }))).find(({ o }) => o && o.w * o.h >= 20)
    if (hit?.o) h.add('text-overlap', a.el, { text: a.text.slice(0, 60), other: b.text.slice(0, 60), otherEl: h.describe(b.el), area: Math.round(hit.o.w * hit.o.h), rect: h.r4(hit.la) })
  }
}

/** Painted boxes, each measured by its painted rect: its layout box less what its clip-paths hide. */
function visibleBoxes(h: Inspector): Item[] {
  return [...document.querySelectorAll('body *')].filter((el) => !(el instanceof SVGElement) && h.isBox(el) && h.opacity(el) > 0.1 && !h.decor(el))
    .map((el) => ({ el, layout: h.asR(el.getBoundingClientRect()) })).filter(({ layout }) => layout.width < h.opts.W - 10)
    .map(({ el, layout }) => ({ el, r: h.clipped(el, layout) })).filter((b): b is Item => b.r !== null && b.r.width > 4 && b.r.height > 4)
}

function checkTextBox(h: Inspector, runs: Run[], boxes: Item[]): void {
  for (const run of runs) for (const b of boxes) {
    if (h.related(run.el, b.el) || !h.textOf(b.el)) continue
    if (b.el.hasAttribute('data-qa-container') && h.within(run.box, b.r)) continue
    const o = run.lines.map((l) => h.inter(h.shrink(l, 1), b.r)).find((x) => x && x.w * x.h >= 20)
    if (o) h.add('text-box', run.el, { text: run.text.slice(0, 50), box: h.describe(b.el), boxText: h.textOf(b.el).slice(0, 40), area: Math.round(o.w * o.h), rect: h.r4(run.box) })
  }
}

function checkBoxes(h: Inspector, boxes: Item[]): void {
  const { W, H } = h.opts
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
    if (h.related(a.el, b.el) || h.sitsOn(a, b)) continue
    const o = h.inter(h.shrink(a.r, 1), h.shrink(b.r, 1))
    if (!o || o.w * o.h < 40) continue
    h.add('box-overlap', a.el, { text: h.textOf(a.el).slice(0, 40), other: h.textOf(b.el).slice(0, 40), otherEl: h.describe(b.el), area: Math.round(o.w * o.h), rect: h.r4(a.r) })
  }
  for (const b of boxes) {
    if (h.inFlight(b.el) || !(b.r.left < -1 || b.r.top < -1 || b.r.right > W + 1 || b.r.bottom > H + 1)) continue
    h.add('off-frame', b.el, { text: h.textOf(b.el).slice(0, 40), rect: h.r4(b.r), ...(h.parked(b.r) && { parked: true }) })
  }
}

function strokes(h: Inspector): SVGGeometryElement[] {
  return [...document.querySelectorAll<SVGGeometryElement>('svg path, svg line, svg polyline, svg ellipse, svg rect')].filter((p) => {
    const s = getComputedStyle(p)
    return s.stroke !== 'none' && parseFloat(s.strokeWidth) > 0 && h.opacity(p) > 0.1 && !p.closest('marker') && !h.decor(p)
  })
}

function drawnPoints(_h: Inspector, path: SVGGeometryElement): [number, number][] {
  const total = path.getTotalLength()
  const s = getComputedStyle(path)
  const scale = path.getAttribute('pathLength') ? total / Number(path.getAttribute('pathLength')) : 1
  const dashed = s.strokeDasharray !== 'none' && path.getAttribute('pathLength')
  const drawn = dashed ? Math.max(0, total - parseFloat(s.strokeDashoffset) * scale) : total
  const m = path.getScreenCTM()
  const pts: [number, number][] = []
  if (!m) return pts
  for (let d = 0; d <= drawn; d += 3) {
    const p = path.getPointAtLength(d)
    pts.push([m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f])
  }
  return pts
}

/** The stroke is visible at (x, y) when no painted box that is not `target`'s own sits above it there. */
function strokeShows(h: Inspector, path: Element, target: Element, x: number, y: number): boolean {
  const stack = document.elementsFromPoint(x, y)
  const at = stack.indexOf(path)
  if (at < 0) return true
  return !stack.slice(0, at).some((e) => h.isBox(e) && !h.related(e, target) && h.opacity(e) > 0.1)
}

function checkEdgeCrossing(h: Inspector, runs: Run[], boxes: Item[]): void {
  const labelled = boxes.filter((b) => h.textOf(b.el))
  const targets = [...runs.map((r) => ({ el: r.el, rects: r.lines, text: r.text, pad: 1 })),
    ...labelled.map((b) => ({ el: b.el, rects: [b.r], text: h.textOf(b.el), pad: 6 }))]
  for (const path of h.strokes()) {
    const pts = h.drawnPoints(path)
    const edge = path.closest('[data-edge]')?.getAttribute('data-edge') ?? h.describe(path)
    for (const t of targets) {
      if (h.related(t.el, path)) continue
      const p = pts.find(([x, y]) => t.rects.some((r) => x > r.left + t.pad && x < r.right - t.pad && y > r.top + t.pad && y < r.bottom - t.pad) && h.strokeShows(path, t.el, x, y))
      if (p) h.add('edge-crossing', t.el, { text: t.text.slice(0, 50), edge, point: p.map(Math.round) })
    }
  }
}

export const OVERLAP_STEPS: PartialSteps<'ink' | 'mergeLines' | 'textRuns' | 'coverAt' | 'markOccluded' | 'checkTextOverlap' | 'visibleBoxes'
  | 'checkTextBox' | 'checkBoxes' | 'strokes' | 'drawnPoints' | 'strokeShows' | 'checkEdgeCrossing'> = {
  ink, mergeLines, textRuns, coverAt, markOccluded, checkTextOverlap, visibleBoxes, checkTextBox, checkBoxes, strokes, drawnPoints, strokeShows,
  checkEdgeCrossing,
}
