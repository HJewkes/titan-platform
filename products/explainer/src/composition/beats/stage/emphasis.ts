import { interpolate } from "@titan-design/react-ui/motion";
import { createContext, useContext, type CSSProperties } from "react";
import type { TimelineBeat } from "../../timeline.js";
import { LIT_RAMP_S } from "../flow.js";
import { FLOW_DWELL_S, mix } from "./video.js";

type Emphases = NonNullable<TimelineBeat["emphases"]>;

/**
 * How lit an element named on a cue at `atS` is at beat-local `t`: the flow token's dwell, so a cue lights its
 * element exactly as the token lights a node. 0 until the ramp, 1 for the dwell from `atS`, then 0 again.
 */
function litAt(t: number, atS: number): number {
  const to = atS + FLOW_DWELL_S;
  return Math.min(interpolate(t, [atS - LIT_RAMP_S, atS], [0, 1]), interpolate(t, [to, to + LIT_RAMP_S], [1, 0]));
}

/** How lit slot element `target` is at beat-local `t`; 0 for an element no cue names after its reveal. */
type Lit = (target: string, t: number) => number;

export function litFrom(emphases: Emphases): Lit {
  return (target, t) => Math.max(0, ...emphases.filter((e) => e.target === target).map((e) => litAt(t, e.atS)));
}

// The arch-map token's lit node: its brand tint and brand border, so every kind lights an element the same way.
const LIT_TINT = 0.25;
const LIT_RING_PX = 4;

interface LitBox {
  /** The element's own background, which the tint mixes into. */
  base?: string;
  /** How far the tint and ring reach past an element with no padding of its own, so the ring clears its text. */
  bleedPx?: number;
}

/**
 * The lit treatment on an element's own box: a brand tint and a brand ring with rounded corners, taking no layout
 * space. Nothing while unlit, so an element no cue names draws as it always did.
 */
export function litBox(lit: number, { base = "transparent", bleedPx = 0 }: LitBox = {}): CSSProperties {
  if (lit <= 0) return {};
  const tint = mix(base, "var(--color-brand-primary)", lit * LIT_TINT);
  const ring = mix("transparent", "var(--color-brand-primary)", lit);
  if (bleedPx === 0) return { background: tint, boxShadow: `inset 0 0 0 ${LIT_RING_PX}px ${ring}`, borderRadius: "var(--beat-radius)" };
  // An outline, not a second shadow: under the translucent tint a wider shadow would show through as a thick band.
  return { background: tint, boxShadow: `0 0 0 ${bleedPx}px ${tint}`, outline: `${LIT_RING_PX}px solid ${ring}`, outlineOffset: bleedPx, borderRadius: "var(--beat-radius)" };
}

const unlit: Lit = () => 0;

export const EmphasisContext = createContext<Lit>(unlit);

export const useLit = (): Lit => useContext(EmphasisContext);
