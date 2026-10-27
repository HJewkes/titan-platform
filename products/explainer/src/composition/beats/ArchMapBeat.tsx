import { useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { MAP, MAP_H, nodeLeft, nodeLit, RAIL_Y, tokenAt } from "./flow.js";
import { fadeUp, mix, progress, SMALL_MOVE_S } from "./stage/video.js";

/**
 * Port of the daily spike's examples/ArchMapBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat, for the fill's
 * one-way path: no loop-back edge, no replay and no inferred (dashed) hops, none of which the fill sets.
 */

type MapSlots = z.infer<(typeof BEAT_SLOTS)["map"]>;

interface MapNode {
  /** The slot element id, set on the node's label as `data-reveal`. */
  id: string;
  label: string;
  /** Beat-local seconds the node is named and appears. */
  atS: number;
}

// flow.ts MAP: five nodes fill the box, and one node is not a path; the fill derives a path only in this range.
const PATH_NODES = { min: 2, max: 5 };
/** The token starts its walk this long after the last node is named. */
const FLOW_AFTER_S = 0.6;
const ARROW_INSET = 14;

// The step number brightens with its node: tertiary text on the lit node's brand tint reads 2.5:1, under QA's floor.
function MapSlot({ node, k, t, lit }: { node: MapNode; k: number; t: number; lit: number }) {
  const filled = progress(t, node.atS);
  return (
    <div className="ex-map-node" style={{
      left: nodeLeft(k), top: MAP.nodeTop, width: MAP.nodeW, height: MAP.nodeH,
      borderStyle: filled > 0 ? "solid" : "dashed",
      borderColor: mix(filled > 0 ? "var(--color-border-prominent)" : "var(--color-hairline-default)", "var(--color-brand-primary)", lit),
      background: mix("var(--color-surface-raised)", "var(--color-brand-primary)", lit * 0.25),
    }}>
      <span className="ex-map-step" style={{ color: mix("var(--color-text-tertiary)", "var(--color-text-primary)", lit) }}>{k + 1}</span>
      <span className="ex-map-label" data-reveal={node.id} style={fadeUp(t, node.atS, 16)}>{node.label}</span>
    </div>
  );
}

/** Each edge draws once both its ends are named. */
function Edges({ nodes, t }: { nodes: readonly MapNode[]; t: number }) {
  return nodes.slice(1).map((node, i) => {
    const drawAtS = Math.max(node.atS, nodes[i]!.atS) + SMALL_MOVE_S;
    const x0 = nodeLeft(i) + MAP.nodeW + ARROW_INSET;
    const x1 = x0 + (MAP.gap - 2 * ARROW_INSET) * progress(t, drawAtS);
    return x1 > x0 ? <line key={node.id} x1={x0} y1={RAIL_Y} x2={x1} y2={RAIL_Y} className="ex-map-edge" markerEnd="url(#ex-arrow)" /> : null;
  });
}

function ArchMapFrame({ headline, nodes }: { headline: string; nodes: readonly MapNode[] }) {
  const { t } = useBeatTime();
  const flowAtS = Math.max(...nodes.map((node) => node.atS)) + FLOW_AFTER_S;
  const token = tokenAt(t, flowAtS, nodes.length);
  return (
    <>
      <h2 className="ex-headline" style={fadeUp(t, 0)}>{headline}</h2>
      <div className="ex-map" style={{ height: MAP_H, opacity: progress(t, 0) }}>
        <svg className="ex-map-svg" width={MAP.width} height={MAP_H}>
          <defs>
            <marker id="ex-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="ex-map-arrowhead" />
            </marker>
          </defs>
          <Edges nodes={nodes} t={t} />
          {token && <circle cx={token[0]} cy={token[1]} r={18} className="ex-map-token" />}
        </svg>
        {nodes.map((node, k) => <MapSlot key={node.id} node={node} k={k} t={t} lit={nodeLit(t, k, flowAtS, nodes.length)} />)}
      </div>
    </>
  );
}

/**
 * arch-map: a left-to-right path of 2 to 5 numbered slots, each node filled as it is named, edges drawn once both
 * ends exist, then a token that walks the path with a 0.8 s dwell per node. A node count outside that range fails
 * the page, since the box holds five and the fill derives no path past it.
 */
export function ArchMapKindBeat({ slots, reveal }: BeatViewProps<MapSlots>) {
  const count = slots.nodes.length;
  if (count < PATH_NODES.min || count > PATH_NODES.max) throw new Error(`arch-map draws ${PATH_NODES.min} to ${PATH_NODES.max} nodes, not ${count}`);
  const nodes = slots.nodes.map((node) => ({ id: node.id, label: node.label, atS: reveal(node.id) ?? 0 }));
  return <ArchMapFrame headline={slots.title ?? ""} nodes={nodes} />;
}
