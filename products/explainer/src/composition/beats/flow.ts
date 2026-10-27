import { interpolate, MOTION } from "@titan-design/react-ui/motion";
import { FLOW_DWELL_S, SMALL_MOVE_S } from "./stage/video.js";

/**
 * Port of the daily spike's examples/flow.ts (SOURCE_REV 6a09ca2) for a one-way path: the fill draws no loop-back
 * edge and no replay, so the token stops at the last node and the loop's path and return walk stay behind.
 */

/** Arch-map geometry on its own 1728 px wide box (90 % of the 1920 canvas). */
export const MAP = { width: 1728, nodeW: 272, gap: 92, nodeTop: 40, nodeH: 240, loopDrop: 150 } as const;
export const RAIL_Y = MAP.nodeTop + MAP.nodeH / 2;
/** The spike's box height, which kept room under the row for its loop edge; a path keeps it so the layout matches. */
export const MAP_H = MAP.nodeTop + MAP.nodeH + MAP.loopDrop + 90;
const HOP_S = SMALL_MOVE_S;
const LIT_RAMP_S = 0.2;

type Point = readonly [number, number];

export const nodeLeft = (k: number) => k * (MAP.nodeW + MAP.gap);
const nodeCenter = (k: number) => nodeLeft(k) + MAP.nodeW / 2;

/** Beat-local seconds the flow token arrives at node `k`: dwell 0.8 s, then a 0.5 s hop. */
function arrivals(flowAtS: number, nodes: number): number[] {
  return Array.from({ length: nodes }, (_, k) => flowAtS + k * (FLOW_DWELL_S + HOP_S));
}

/** Beat-local seconds the token has rested its last dwell and leaves the map. */
const flowEndS = (flowAtS: number, nodes: number): number => flowAtS + (nodes - 1) * (FLOW_DWELL_S + HOP_S) + FLOW_DWELL_S;

/** Token position at beat-local `t`, or null before the flow starts and after it ends. It hops the row left to right. */
export function tokenAt(t: number, flowAtS: number, nodes: number): Point | null {
  if (t < flowAtS || t >= flowEndS(flowAtS, nodes)) return null;
  const times = arrivals(flowAtS, nodes);
  for (let k = 0; k < nodes - 1; k++) {
    const leave = times[k]! + FLOW_DWELL_S;
    if (t < leave) return [nodeCenter(k), RAIL_Y];
    if (t < leave + HOP_S) return [interpolate(t, [leave, leave + HOP_S], [nodeCenter(k), nodeCenter(k + 1)], { ease: MOTION.ease.inOut }), RAIL_Y];
  }
  return [nodeCenter(nodes - 1), RAIL_Y];
}

/** 1 while the token dwells in node `k`, ramping 0.2 s each side. */
export function nodeLit(t: number, k: number, flowAtS: number, nodes: number): number {
  const at = arrivals(flowAtS, nodes)[k]!;
  const to = at + FLOW_DWELL_S;
  return Math.min(interpolate(t, [at - LIT_RAMP_S, at], [0, 1]), interpolate(t, [to, to + LIT_RAMP_S], [1, 0]));
}
