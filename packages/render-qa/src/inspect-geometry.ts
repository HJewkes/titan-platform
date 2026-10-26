/**
 * Geometry and paint primitives of the in-page inspector. Each step is serialised on its own and runs in the page:
 * no imports at runtime, no closures over module scope, and other steps are reached only through `h`.
 */
import type { Inspector, Item, PartialSteps, Rect, Rect4, Rgba } from './inspect-types.js'

function rgba(h: Inspector, css: string): Rgba {
  const { ctx } = h
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = 'rgba(0,0,0,0)'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b, a / 255]
}

function opacity(_h: Inspector, el: Element | null): number {
  let o = 1
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const s = getComputedStyle(e)
    if (s.visibility === 'hidden' || s.display === 'none') return 0
    o *= Number(s.opacity)
  }
  return o
}

function describe(_h: Inspector, el: Element): string {
  const owner = el.closest('[class]')
  const cls = (owner?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

function r4(_h: Inspector, r: { left: number; top: number; width: number; height: number }): Rect4 {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

function rect(_h: Inspector, left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function inter(_h: Inspector, a: Rect, b: Rect): { w: number; h: number } | null {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? { w, h } : null
}

function shrink(h: Inspector, r: Rect, d: number): Rect {
  return h.rect(r.left + d, r.top + d, r.right - d, r.bottom - d)
}

function unionRect(h: Inspector, rs: Rect[]): Rect {
  return h.rect(Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom)))
}

function asR(h: Inspector, r: DOMRect): Rect {
  return h.rect(r.left, r.top, r.right, r.bottom)
}

function related(_h: Inspector, a: Element, b: Element): boolean {
  return a === b || a.contains(b) || b.contains(a)
}

function decor(_h: Inspector, el: Element): boolean {
  return el.closest('[data-qa-decor]') !== null
}

function inFlight(_h: Inspector, el: Element): boolean {
  return el.closest('[data-qa-camera]') !== null
}

function within(_h: Inspector, inner: Rect, outer: Rect): boolean {
  return inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1
}

/** `a` is a marked container and `b` lies inside it (or the other way round): they are allowed to overlap. */
function sitsOn(h: Inspector, a: Item, b: Item): boolean {
  return (a.el.hasAttribute('data-qa-container') && h.within(b.r, a.r)) || (b.el.hasAttribute('data-qa-container') && h.within(a.r, b.r))
}

function isBox(h: Inspector, el: Element): boolean {
  if (el instanceof SVGElement) return false
  const s = getComputedStyle(el)
  return h.rgba(s.backgroundColor)[3] > 0.05 || (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none')
}

function isPainted(h: Inspector, el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'svg') return false
  if (el instanceof SVGGraphicsElement) return !['g', 'defs', 'marker'].includes(tag)
  return h.isBox(el)
}

function textOf(_h: Inspector, el: Element): string {
  return el.textContent.trim()
}

function twinOf(h: Inspector, el: Element): { twin?: number } {
  const text = h.textOf(el)
  const same = [...document.getElementsByTagName(el.tagName)].filter((o) => o.getAttribute('class') === el.getAttribute('class') && h.textOf(o) === text)
  return same.length > 1 ? { twin: same.indexOf(el) } : {}
}

function add(h: Inspector, kind: string, el: Element, detail: Record<string, unknown> & { rect?: Rect4 }): void {
  h.findings.push({ kind, el: h.describe(el), at: detail.rect ?? h.r4(el.getBoundingClientRect()), ...h.twinOf(el), ...detail })
}

/** A box's padding box: inside its border. */
function innerOf(h: Inspector, el: Element): Rect {
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return h.rect(r.left + parseFloat(s.borderLeftWidth), r.top + parseFloat(s.borderTopWidth), r.right - parseFloat(s.borderRightWidth), r.bottom - parseFloat(s.borderBottomWidth))
}

/** The part of `r` left after every `clip-path: inset(...)` on `el` and its ancestors. */
function clipped(h: Inspector, el: Element, r: Rect): Rect | null {
  let out = r
  for (let e: Element | null = el; e && e.nodeType === 1; e = e.parentElement) {
    const m = /^inset\(([^)]*)\)/.exec(getComputedStyle(e).clipPath)
    if (!m) continue
    const v = (m[1] ?? '').trim().split(/\s+/).map(parseFloat)
    const [t, rt, b, l] = [v[0] ?? 0, v[1] ?? v[0] ?? 0, v[2] ?? v[0] ?? 0, v[3] ?? v[1] ?? v[0] ?? 0]
    const box = h.asR(e.getBoundingClientRect())
    const c = h.rect(Math.max(out.left, box.left + l), Math.max(out.top, box.top + t), Math.min(out.right, box.right - rt), Math.min(out.bottom, box.bottom - b))
    if (c.width <= 0 || c.height <= 0) return null
    out = c
  }
  return out
}

function shown(h: Inspector, el: Element): boolean {
  return h.opacity(el) > 0.1 && h.clipped(el, h.asR(el.getBoundingClientRect())) !== null
}

export const GEOMETRY_STEPS: PartialSteps<'rgba' | 'opacity' | 'describe' | 'r4' | 'rect' | 'inter' | 'shrink' | 'unionRect' | 'asR' | 'related'
  | 'decor' | 'inFlight' | 'within' | 'sitsOn' | 'isBox' | 'isPainted' | 'textOf' | 'twinOf' | 'add' | 'innerOf' | 'clipped' | 'shown'> = {
  rgba, opacity, describe, r4, rect, inter, shrink, unionRect, asR, related, decor, inFlight, within, sitsOn, isBox, isPainted, textOf, twinOf, add,
  innerOf, clipped, shown,
}
