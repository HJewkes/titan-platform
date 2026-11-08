/**
 * The CSS gradients the contrast rule can sample: one `linear-gradient` or `radial-gradient` layer read from its
 * computed `background-image`, so the colour under any point of a text box is known. Anything this does not model
 * (a repeating or conic gradient, a colour hint, a `calc()` stop) comes back as a reason string, never a guess. Steps
 * run in the page; see inspect-geometry.ts.
 */
import type { Gradient, GradientShape, Inspector, PartialSteps, Point, Rect, Rgba, Stop } from './inspect-types.js'

function gradient(h: Inspector, css: string, r: Rect): Gradient | string {
  const m = /^(linear|radial)-gradient\((.*)\)$/s.exec(css)
  if (!m) return `background ${css.slice(0, Math.max(0, css.indexOf('('))) || css}`
  const args = h.splitTop(m[2] ?? '', ',')
  const lead = h.splitTop(args[0] ?? '', ' ')[0] ?? ''
  const head = CSS.supports('color', lead) ? undefined : args.shift()
  const shape = m[1] === 'linear' ? h.linearGradient(head, r) : h.radialGradient(head ?? '', r)
  if (typeof shape === 'string') return shape
  const stops = h.stops(args, shape.reach)
  return typeof stops === 'string' ? stops : { stops, centre: shape.centre, axis: shape.axis, radial: shape.radial }
}

/** The gradient line through the box's centre, as long as CSS makes it: `|w sin a| + |h cos a|`. */
function linearGradient(_h: Inspector, head: string | undefined, r: Rect): GradientShape | string {
  const words = (head ?? 'to bottom').trim().split(/\s+/)
  let dir: Point
  if (words[0] === 'to') {
    const dx = Number(words.includes('right')) - Number(words.includes('left'))
    const dy = Number(words.includes('bottom')) - Number(words.includes('top'))
    dir = dx && dy ? [dx * r.height, dy * r.width] : [dx, dy]
  } else {
    const m = /^(-?[\d.]+)(deg|grad|rad|turn)$/.exec(head ?? '')
    const perTurn: Record<string, number> = { deg: 360, grad: 400, rad: 2 * Math.PI, turn: 1 }
    if (!m) return `gradient direction ${head ?? ''}`
    const a = (Number(m[1]) / (perTurn[m[2] ?? ''] ?? 1)) * 2 * Math.PI
    dir = [Math.sin(a), -Math.cos(a)]
  }
  const n = Math.hypot(dir[0], dir[1])
  const [ux, uy] = [dir[0] / n, dir[1] / n]
  const reach = Math.abs(r.width * ux) + Math.abs(r.height * uy)
  if (!n || !reach) return 'degenerate gradient'
  return { centre: [r.left + r.width / 2, r.top + r.height / 2], axis: [ux / reach, uy / reach], radial: false, reach }
}

/** A radial gradient's centre and radii from `[shape] [size] [at <x> <y>]`; the four-value position is not modelled. */
function radialGradient(h: Inspector, head: string, r: Rect): GradientShape | string {
  const words = head.trim().split(/\s+/).filter(Boolean)
  const at = words.indexOf('at')
  const size = at < 0 ? words : words.slice(0, at)
  const pos = at < 0 ? [] : words.slice(at + 1)
  if (pos[0] === 'top' || pos[0] === 'bottom') pos.reverse()
  const place = (t: string | undefined, ref: number) => (t === undefined || t === 'center' ? ref / 2 : t === 'left' || t === 'top' ? 0 : t === 'right' || t === 'bottom' ? ref : h.lengthOf(t, ref))
  const centre: Point = [place(pos[0], r.width), place(pos[1], r.height)]
  if (pos.length > 2 || centre.some(Number.isNaN)) return 'radial gradient position'
  const lengths = size.filter((w) => !Number.isNaN(h.lengthOf(w, 1)))
  const circle = size.includes('circle') || (!size.includes('ellipse') && lengths.length === 1)
  const radii = h.radii(size.filter((w) => w !== 'circle' && w !== 'ellipse'), circle, centre, r)
  if (typeof radii === 'string') return radii
  return { centre: [r.left + centre[0], r.top + centre[1]], axis: [1 / radii[0], 1 / radii[1]], radial: true, reach: radii[0] }
}

/** The ending shape's radii per CSS: a corner-sized ellipse keeps its side-sized aspect ratio, so it grows by root 2. */
function radii(h: Inspector, size: string[], circle: boolean, centre: Point, r: Rect): Point | string {
  const word = size[0] ?? 'farthest-corner'
  if (/^(closest|farthest)-(side|corner)$/.test(word)) {
    const pick = word.startsWith('farthest') ? Math.max : Math.min
    const [sx, sy] = [pick(centre[0], r.width - centre[0]), pick(centre[1], r.height - centre[1])]
    const corner = word.endsWith('corner')
    const round = corner ? Math.hypot(sx, sy) : pick(sx, sy)
    const [rx, ry] = circle ? [round, round] : [sx * (corner ? Math.SQRT2 : 1), sy * (corner ? Math.SQRT2 : 1)]
    return rx > 0 && ry > 0 ? [rx, ry] : 'degenerate gradient'
  }
  const [rx = NaN, ry = circle ? rx : NaN] = size.map((t, i) => h.lengthOf(t, i ? r.height : r.width))
  return size.length <= 2 && rx > 0 && ry > 0 ? [rx, ry] : 'radial gradient size'
}

/** A `px` or `%` length in px, `%` of `ref`; NaN for anything else (`calc()`, `em`). */
function lengthOf(_h: Inspector, token: string, ref: number): number {
  const m = /^(-?[\d.]+)(px|%)$/.exec(token)
  return m ? Number(m[1]) * (m[2] === '%' ? ref / 100 : 1) : NaN
}

/** Each stop's colour and its place on a line `len` px long; a stop with two positions is two stops. */
function stops(h: Inspector, args: string[], len: number): Stop[] | string {
  const raw: { c: Rgba; at?: number }[] = []
  for (const arg of args) {
    const [colour = '', ...pos] = h.splitTop(arg, ' ')
    if (!CSS.supports('color', colour) || pos.length > 2) return 'gradient colour hint'
    const at = pos.map((p) => h.lengthOf(p, len) / len)
    if (at.some(Number.isNaN)) return 'gradient stop position'
    const c = h.rgba(colour)
    if (at.length === 0) raw.push({ c })
    for (const a of at) raw.push({ c, at: a })
  }
  return raw.length > 0 ? h.spreadStops(raw) : 'gradient stops'
}

/** CSS's stop fix-up: ends default to 0 and 1, a position never runs backwards, unplaced stops share their gap evenly. */
function spreadStops(_h: Inspector, raw: { c: Rgba; at?: number }[]): Stop[] {
  const at = raw.map((s) => s.at)
  if (at[0] === undefined) at[0] = 0
  if (at[at.length - 1] === undefined) at[at.length - 1] = 1
  let floor = -Infinity
  for (const [i, a] of at.entries()) if (a !== undefined) at[i] = floor = Math.max(floor, a)
  for (let i = 1; i < at.length; i++) {
    if (at[i] !== undefined) continue
    let j = i
    while (at[j] === undefined) j++
    const [from, to] = [at[i - 1] ?? 0, at[j] ?? 1]
    for (let k = i; k < j; k++) at[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1)
  }
  return raw.map((s, i) => ({ c: s.c, at: at[i] ?? 0 }))
}

/** The gradient's colour at a point, interpolated between its stops in premultiplied sRGB as CSS does. */
function gradientAt(_h: Inspector, g: Gradient, [x, y]: Point): Rgba {
  const [dx, dy] = [(x - g.centre[0]) * g.axis[0], (y - g.centre[1]) * g.axis[1]]
  const t = g.radial ? Math.hypot(dx, dy) : dx + dy + 0.5
  const next = g.stops.findIndex((s) => s.at >= t)
  const [a, b] = next < 0 ? [g.stops[g.stops.length - 1], undefined] : [g.stops[next - 1], g.stops[next]]
  if (!a || !b) return (a ?? b ?? { c: [0, 0, 0, 0] }).c
  const k = b.at > a.at ? (t - a.at) / (b.at - a.at) : 1
  const alpha = a.c[3] + (b.c[3] - a.c[3]) * k
  const mix = (i: number) => (alpha ? ((a.c[i] ?? 0) * a.c[3] * (1 - k) + (b.c[i] ?? 0) * b.c[3] * k) / alpha : 0)
  return [mix(0), mix(1), mix(2), alpha]
}

export const GRADIENT_STEPS: PartialSteps<'gradient' | 'linearGradient' | 'radialGradient' | 'radii' | 'lengthOf' | 'stops' | 'spreadStops' | 'gradientAt'> = {
  gradient, linearGradient, radialGradient, radii, lengthOf, stops, spreadStops, gradientAt }
