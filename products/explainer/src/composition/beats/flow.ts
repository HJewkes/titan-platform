import { interpolate, MOTION } from "@titan-design/react-ui/motion";
import { FLOW_DWELL_S, SMALL_MOVE_S } from "./stage/video.js";

/**
 * Port of the daily spike's examples/flow.ts (SOURCE_REV 6a09ca2) for a one-way path: the fill draws no loop-back
 * edge and no replay, so the token stops at the last node and the loop's path and return walk stay behind.
 */

/** Arch-map geometry on its own 1728 px wide box (90 % of the 1920 canvas). */
export const MAP = { width: 1728, maxNodeW: 480, gap: 92, nodeTop: 40, nodeH: 240 } as const;
export const RAIL_Y = MAP.nodeTop + MAP.nodeH / 2;
/** A one-way path draws no loop-back edge, so the box ends under the row instead of reserving the spike's loop space. */
export const MAP_H = MAP.nodeTop * 2 + MAP.nodeH;
const HOP_S = SMALL_MOVE_S;
export const LIT_RAMP_S = 0.2;

type Point = readonly [number, number];

/** Nodes share the box's width, capped so a two-node path does not stretch; a short row is centred in the box. */
export const nodeWidth = (nodes: number) => Math.min(MAP.maxNodeW, (MAP.width - (nodes - 1) * MAP.gap) / nodes);
const rowLeft = (nodes: number) => (MAP.width - (nodes * nodeWidth(nodes) + (nodes - 1) * MAP.gap)) / 2;
export const nodeLeft = (k: number, nodes: number) => rowLeft(nodes) + k * (nodeWidth(nodes) + MAP.gap);
const nodeCenter = (k: number, nodes: number) => nodeLeft(k, nodes) + nodeWidth(nodes) / 2;

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
    if (t < leave) return [nodeCenter(k, nodes), RAIL_Y];
    if (t < leave + HOP_S) return [interpolate(t, [leave, leave + HOP_S], [nodeCenter(k, nodes), nodeCenter(k + 1, nodes)], { ease: MOTION.ease.inOut }), RAIL_Y];
  }
  return [nodeCenter(nodes - 1, nodes), RAIL_Y];
}

/** 1 while the token dwells in node `k`, ramping 0.2 s each side. */
export function nodeLit(t: number, k: number, flowAtS: number, nodes: number): number {
  const at = arrivals(flowAtS, nodes)[k]!;
  const to = at + FLOW_DWELL_S;
  return Math.min(interpolate(t, [at - LIT_RAMP_S, at], [0, 1]), interpolate(t, [to, to + LIT_RAMP_S], [1, 0]));
}
