import type { RgbaFrame } from '../pops.js'
import { drawScene, SCENE_HEIGHT } from './rgba-scene.js'

/** The t at which the square mounts with no transition. */
export const POP_AT = 0.6

/** A slow 12 px bar, plus an 8 x 8 square that appears all at once at `POP_AT`. */
export function plantedPop(t: number): RgbaFrame {
  const bar = { x: Math.round(4 * t), y: 0, width: 12, height: SCENE_HEIGHT }
  const square = { x: 36, y: 0, width: 8, height: 8 }
  return drawScene(t >= POP_AT ? [bar, square] : [bar])
}
