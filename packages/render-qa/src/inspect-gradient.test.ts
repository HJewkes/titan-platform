import { partialFake } from '@titan-design/test-kit'
import { describe, expect, it } from 'vitest'
import { GRADIENT_STEPS } from './inspect-gradient.js'
import type { Gradient, GradientShape, Inspector, Rect, Rgba } from './inspect-types.js'

/** The gradient steps bound to one inspector, as the page binds them; the steps here need no DOM. */
const h = partialFake<Inspector>()
Object.assign(h, Object.fromEntries(Object.entries(GRADIENT_STEPS).map(([name, step]) => [name, (...args: unknown[]): unknown => Reflect.apply(step, undefined, [h, ...args])])))

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height })
const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [255, 255, 255, 1]
const blackToWhite = (shape: GradientShape | string): Gradient => {
  if (typeof shape === 'string') throw new Error(shape)
  return { ...shape, stops: [{ c: BLACK, at: 0 }, { c: WHITE, at: 1 }] }
}
const greyAt = (g: Gradient, x: number, y: number) => Math.round(h.gradientAt(g, [x, y])[0])

describe('gradient sampling under a text box', () => {
  it('reads a 90deg linear gradient as running left to right across the box', () => {
    // Arrange
    const g = blackToWhite(h.linearGradient('90deg', box(100, 0, 200, 50)))

    // Act / Assert
    expect([greyAt(g, 100, 25), greyAt(g, 200, 25), greyAt(g, 300, 25)]).toEqual([0, 128, 255])
  })

  it('runs the default linear gradient top to bottom', () => {
    // Arrange
    const g = blackToWhite(h.linearGradient(undefined, box(0, 0, 100, 100)))

    // Act / Assert
    expect([greyAt(g, 50, 0), greyAt(g, 50, 100)]).toEqual([0, 255])
  })

  it('reaches a radial circle\'s edge at its closest side', () => {
    // Arrange
    const g = blackToWhite(h.radialGradient('circle closest-side at 50% 50%', box(0, 0, 200, 100)))

    // Act / Assert: radius 50 px from the centre at (100, 50)
    expect([greyAt(g, 100, 50), greyAt(g, 125, 50), greyAt(g, 150, 50), greyAt(g, 190, 50)]).toEqual([0, 128, 255, 255])
  })

  it('reaches the farthest corner with the default ellipse', () => {
    // Arrange
    const g = blackToWhite(h.radialGradient('', box(0, 0, 200, 100)))

    // Act / Assert
    expect([greyAt(g, 100, 50), greyAt(g, 200, 100)]).toEqual([0, 255])
  })

  it('reads a single vertical keyword in a radial position as centre-x', () => {
    // Arrange
    const r = box(0, 0, 200, 100)

    // Act
    const [top, bottom] = [h.radialGradient('at top', r), h.radialGradient('at bottom', r)]

    // Assert
    expect([top, bottom].map((s) => (typeof s === 'string' ? s : s.centre))).toEqual([[100, 0], [100, 100]])
  })

  it('names a radial position it does not model instead of guessing', () => {
    // Act / Assert
    expect(h.radialGradient('circle at right 10px top 5px', box(0, 0, 100, 100))).toBe('radial gradient position')
  })

  it('spreads unplaced stops evenly and never lets a position run backwards', () => {
    // Act
    const stops = h.spreadStops([{ c: BLACK }, { c: WHITE }, { c: BLACK, at: 0.8 }, { c: WHITE, at: 0.5 }, { c: BLACK }])

    // Assert
    expect(stops.map((s) => Math.round(s.at * 100))).toEqual([0, 40, 80, 80, 100])
  })
})
