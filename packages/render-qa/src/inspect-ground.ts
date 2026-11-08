/**
 * What a text run sits on, for the contrast rule: the ancestor walk from the run's element up to the first opaque
 * paint, every translucent colour and gradient on the way composited over the page background. A gradient is sampled
 * at points under the run's box, so the rule can score the worst one. Paint the walk cannot model (a background image,
 * a filter, a blend mode, a backdrop filter) gives no colour at all, only the reason. Steps run in the page; see
 * inspect-geometry.ts.
 */
import type { Ground, Inspector, Layer, PartialSteps, Point, Rect, Rgb } from './inspect-types.js'

/** `s` split at each `sep` outside parentheses, so `rgb(1, 2, 3) 40%` stays one stop. */
function splitTop(_h: Inspector, s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === sep && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Why an element's paint cannot be modelled from its styles. A filter or blend mode anywhere up the tree changes the
 * colours the text is drawn in; `behind` marks an element whose own background still shows under the text.
 */
function unmodelled(_h: Inspector, e: Element, behind: boolean): string | undefined {
  const s = getComputedStyle(e)
  if (s.filter !== 'none') return 'filter'
  if (s.mixBlendMode !== 'normal') return 'mix-blend-mode'
  if (!behind) return undefined
  if ((s.backdropFilter || 'none') !== 'none') return 'backdrop-filter'
  if (s.backgroundClip === 'text') return 'background-clip: text'
  if (s.backgroundImage.includes('url(')) return 'background image'
  if (s.backgroundImage !== 'none' && !/^auto( auto)?(, auto( auto)?)*$/.test(s.backgroundSize)) return 'background-size'
  return undefined
}

/** An element's own paint, nearest the text first: its background image over its background colour. */
function paintsOf(h: Inspector, e: Element): Layer[] | string {
  const s = getComputedStyle(e)
  const op = h.opacity(e)
  const colour = h.rgba(s.backgroundColor)
  const under: Layer[] = colour[3] > 0 ? [{ c: colour, op }] : []
  if (s.backgroundImage === 'none') return under
  if (h.splitTop(s.backgroundImage, ',').length > 1) return 'layered background images'
  const g = h.gradient(s.backgroundImage, h.asR(e.getBoundingClientRect()))
  return typeof g === 'string' ? g : [{ g, op }, ...under]
}

function opaque(_h: Inspector, layer: Layer): boolean {
  return layer.op >= 0.999 && ('c' in layer ? layer.c[3] >= 0.999 : layer.g.stops.every((s) => s.c[3] >= 0.999))
}

/** The paint layers under `el`, nearest first, down to the first opaque one; or why they cannot be modelled. */
function groundLayers(h: Inspector, el: Element): Layer[] | string {
  const layers: Layer[] = []
  let e: Element | null = el
  for (; e && e.nodeType === 1; e = e.parentElement) {
    if (e instanceof SVGElement) continue
    const paints = h.unmodelled(e, true) ?? h.paintsOf(e)
    if (typeof paints === 'string') return paints
    layers.push(...paints)
    if (paints.some((p) => h.opaque(p))) break
  }
  for (e = e?.parentElement ?? null; e && e.nodeType === 1; e = e.parentElement) {
    const why = e instanceof SVGElement ? undefined : h.unmodelled(e, false)
    if (why) return why
  }
  return layers
}

/** The layers' colour at one point, each drawn over the ones below it and the lowest over `base`. */
function composite(h: Inspector, layers: Layer[], base: Rgb, at: Point): Rgb {
  return layers.reduceRight((under, l) => h.blend('c' in l ? l.c : h.gradientAt(l.g, at), l.op, under), base)
}

/** A 5 by 3 grid of points spread over the box, where a gradient under the text is sampled. */
function samplePoints(_h: Inspector, box: Rect): Point[] {
  const points: Point[] = []
  for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) points.push([box.left + (box.width * (i + 0.5)) / 5, box.top + (box.height * (j + 0.5)) / 3])
  return points
}

function bgBehind(h: Inspector, el: Element, box: Rect): Ground {
  const layers = h.groundLayers(el)
  if (typeof layers === 'string') return { unmeasured: layers }
  const base = h.pageBg()
  const points = layers.some((l) => 'g' in l) ? h.samplePoints(box) : [[box.left, box.top] as Point]
  return { samples: points.map((at) => h.composite(layers, base, at)) }
}

export const GROUND_STEPS: PartialSteps<'splitTop' | 'unmodelled' | 'paintsOf' | 'opaque' | 'groundLayers' | 'composite' | 'samplePoints' | 'bgBehind'> = {
  splitTop, unmodelled, paintsOf, opaque, groundLayers, composite, samplePoints, bgBehind,
}
