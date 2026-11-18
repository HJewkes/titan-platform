import type { RgbaFrame } from '../pops.js'
import { drawScene, SCENE_HEIGHT } from './rgba-scene.js'

/** Pixels the bar travels per unit of t: fast enough that every grid step passes the threshold. */
export const SWEEP_SPEED = 32

/** A 12 px bar sweeping right at constant speed over t in [0, 1]. */
export function smoothSweep(t: number): RgbaFrame {
  return drawScene([{ x: Math.round(SWEEP_SPEED * t), y: 0, width: 12, height: SCENE_HEIGHT }])
}
