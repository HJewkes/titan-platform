/**
 * DOM probe at chosen moments: every visible text run with its font size, tag, class list, one box per rendered line
 * and every ancestor that clips it; and every visible element that holds content (text or paint) with its box. The
 * explainer's pure checks (clipped text, content fill, empty stage) read these, through their own types.
 *
 * Steps are serialised one by one and reach each other through `p`, as inspect.ts's do, so a bundler that renames a
 * module-scope function cannot break the page-side calls.
 */
import { captureFrame } from '@titan-design/frame-capture'
import type { Page } from 'playwright-core'

export interface ProbeBox {
  x: number
  y: number
  width: number
  height: number
}

/** An ancestor that cuts off what lies outside its box: overflow other than visible, or a clip-path. */
export interface ProbedClip {
  element: string
  box: ProbeBox
}

export interface ProbedText {
  text: string
  px: number
  tag: string
  /** Class list of the nearest element that has one, so a check can tell headlines, labels and code apart. */
  cls: string
  element: string
  /** One box per rendered line, top to bottom. */
  lines: ProbeBox[]
  /** The element itself when it clips, then every clipping ancestor, painted or not: an unpainted band still cuts. */
  clips: ProbedClip[]
}

export interface ProbedBox {
  element: string
  box: ProbeBox
  /** The element or an ancestor carries `data-qa-decor`. */
  decor?: boolean
}

export interface ProbedMoment {
  beat: string
  t: number
  texts: ProbedText[]
  boxes: ProbedBox[]
}

export interface ProbeAt {
  beat: string
  /** Seconds from the start of the video. */
  t: number
}

/** The probe as the page sees it: every step bound to this object. */
interface Prober {
  shown(el: Element): boolean
  describe(el: Element): string
  box(r: { left: number; top: number; width: number; height: number }): ProbeBox
  union(a: ProbeBox, b: ProbeBox): ProbeBox
  lineBoxes(node: Text): ProbeBox[]
  insetBox(el: Element, clipPath: string): ProbeBox
  clips(el: Element): ProbedClip[]
  texts(): ProbedText[]
  paints(color: string): boolean
  holdsContent(el: Element): boolean
  boxes(): ProbedBox[]
  probe(): Pick<ProbedMoment, 'texts' | 'boxes'>
}

type Unbound<F> = F extends (...args: infer A) => infer R ? (p: Prober, ...args: A) => R : never
type Steps = { [K in keyof Prober]: Unbound<Prober[K]> }

/** Visible: no ancestor hidden, and the product of ancestor opacities above 0.1. */
function shown(_p: Prober, el: Element): boolean {
  let opacity = 1
  for (let e: Element | null = el; e; e = e.parentElement) {
    const style = getComputedStyle(e)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    opacity *= Number(style.opacity)
  }
  return opacity > 0.1
}

function describe(_p: Prober, el: Element): string {
  const owner = el.closest('[class]')
  const cls = (owner?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

function box(_p: Prober, r: { left: number; top: number; width: number; height: number }): ProbeBox {
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function union(_p: Prober, a: ProbeBox, b: ProbeBox): ProbeBox {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/** A text node's line fragments, merged so each rendered line is one box. */
function lineBoxes(p: Prober, node: Text): ProbeBox[] {
  const range = document.createRange()
  range.selectNodeContents(node)
  const lines: ProbeBox[] = []
  for (const r of range.getClientRects()) {
    if (r.width <= 0 || r.height <= 0) continue
    const i = lines.findIndex((l) => r.top < l.y + l.height && l.y < r.bottom)
    const line = lines[i]
    if (line) lines[i] = p.union(line, p.box(r))
    else lines.push(p.box(r))
  }
  return lines.sort((a, b) => a.y - b.y)
}

/** The box a `clip-path: inset(...)` leaves; any other shape counts as the element's own box. */
function insetBox(p: Prober, el: Element, clipPath: string): ProbeBox {
  const r = el.getBoundingClientRect()
  const inset = /^inset\(([^)]*)\)/.exec(clipPath)?.[1]?.split(/\s+round\s+/)[0]?.trim().split(/\s+/)
  if (!inset) return p.box(r)
  const [top = '0', right = top, bottom = top, left = right] = inset
  const len = (v: string, of: number) => (v.endsWith('%') ? (Number.parseFloat(v) / 100) * of : Number.parseFloat(v) || 0)
  const [t, rt, b, l] = [len(top, r.height), len(right, r.width), len(bottom, r.height), len(left, r.width)]
  return { x: r.left + l, y: r.top + t, width: r.width - l - rt, height: r.height - t - b }
}

function clips(p: Prober, el: Element): ProbedClip[] {
  const out: ProbedClip[] = []
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    const style = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    const paddingBox = { x: r.left + e.clientLeft, y: r.top + e.clientTop, width: e.clientWidth, height: e.clientHeight }
    if (style.clipPath !== 'none') out.push({ element: p.describe(e), box: p.insetBox(e, style.clipPath) })
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') out.push({ element: p.describe(e), box: paddingBox })
  }
  return out
}

function texts(p: Prober): ProbedText[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const out: ProbedText[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue
    const text = node.textContent.trim()
    const el = node.parentElement
    if (!text || !el || !p.shown(el)) continue
    const cls = (el.closest('[class]')?.getAttribute('class') ?? '').trim()
    const tag = el.tagName.toLowerCase()
    out.push({ text, px: Number.parseFloat(getComputedStyle(el).fontSize), tag, cls, element: p.describe(el), lines: p.lineBoxes(node), clips: p.clips(el) })
  }
  return out
}

/** A computed colour paints when its alpha is above the threshold; the colour-space name and channel tokens are never read as alpha. */
function paints(_p: Prober, color: string): boolean {
  const args = color.match(/^\s*[a-z-]+\(([^)]*)\)\s*$/i)?.[1]
  if (args === undefined) return false
  const [channels = '', alpha] = args.split('/')
  if (alpha === undefined) {
    const legacy = channels.split(',').map((c) => c.trim())
    if (legacy.length === 4) return Number.parseFloat(legacy[3] ?? '') > 0.05
    return true
  }
  const token = alpha.trim()
  const value = token.endsWith('%') ? Number.parseFloat(token) / 100 : token === 'none' ? 0 : Number(token)
  return value > 0.05
}

/** Own text, a fill or border, or a replaced or drawn element; an empty layout wrapper holds nothing. */
function holdsContent(p: Prober, el: Element): boolean {
  if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) return true
  if (['img', 'canvas', 'video'].includes(el.tagName.toLowerCase())) return true
  if (el instanceof SVGGraphicsElement) return !['svg', 'g', 'defs', 'marker'].includes(el.tagName.toLowerCase())
  const style = getComputedStyle(el)
  return p.paints(style.backgroundColor) || style.backgroundImage !== 'none' || (Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none')
}

function boxes(p: Prober): ProbedBox[] {
  return [...document.body.querySelectorAll('*')].flatMap((el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || !p.shown(el) || !p.holdsContent(el)) return []
    return [{ element: p.describe(el), box: p.box(r), ...(el.closest('[data-qa-decor]') ? { decor: true } : {}) }]
  })
}

function probe(p: Prober): Pick<ProbedMoment, 'texts' | 'boxes'> {
  return { texts: p.texts(), boxes: p.boxes() }
}

const STEPS: Steps = { shown, describe, box, union, lineBoxes, insetBox, clips, texts, paints, holdsContent, boxes, probe }

function runProber(steps: Record<string, (p: unknown, ...args: unknown[]) => unknown>): unknown {
  const p: Record<string, (...args: unknown[]) => unknown> = {}
  for (const [name, step] of Object.entries(steps)) p[name] = (...args: unknown[]) => step(p, ...args)
  return p.probe?.()
}

const PROBE_SOURCE = `(${String(runProber)})({ ${Object.entries(STEPS).map(([name, step]) => `${name}: ${String(step)}`).join(', ')} })`

/** Seeks to each moment with the capture loop's own virtual-time path and probes the frame there, in order. */
export async function probeMoments(page: Page, moments: readonly ProbeAt[]): Promise<ProbedMoment[]> {
  const out: ProbedMoment[] = []
  for (const { beat, t } of moments) {
    await captureFrame(page, t)
    const measured: Pick<ProbedMoment, 'texts' | 'boxes'> = await page.evaluate(PROBE_SOURCE)
    out.push({ beat, t, ...measured })
  }
  return out
}
