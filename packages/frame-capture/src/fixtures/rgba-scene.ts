import type { RgbaFrame } from '../pops.js'

export const SCENE_WIDTH = 48
export const SCENE_HEIGHT = 8

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Paints opaque white rectangles on a transparent black frame, clipped to the frame. */
export function drawScene(rects: readonly Rect[]): RgbaFrame {
  const data = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT * 4)
  for (const rect of rects) {
    for (let y = Math.max(0, rect.y); y < Math.min(SCENE_HEIGHT, rect.y + rect.height); y++) {
      for (let x = Math.max(0, rect.x); x < Math.min(SCENE_WIDTH, rect.x + rect.width); x++) {
        data.fill(255, (y * SCENE_WIDTH + x) * 4, (y * SCENE_WIDTH + x + 1) * 4)
      }
    }
  }
  return { width: SCENE_WIDTH, height: SCENE_HEIGHT, data }
}
