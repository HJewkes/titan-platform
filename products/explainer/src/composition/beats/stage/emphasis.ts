import { interpolate } from "@titan-design/react-ui/motion";
import { createContext, useContext } from "react";
import type { TimelineBeat } from "../../timeline.js";
import { LIT_RAMP_S } from "../flow.js";
import { FLOW_DWELL_S, mix } from "./video.js";

type Emphases = NonNullable<TimelineBeat["emphases"]>;

/**
 * How lit an element named on a cue at `atS` is at beat-local `t`: the flow token's dwell, so a cue lights its
 * element exactly as the token lights a node. 0 until the ramp, 1 for the dwell from `atS`, then 0 again.
 */
export function litAt(t: number, atS: number): number {
  const to = atS + FLOW_DWELL_S;
  return Math.min(interpolate(t, [atS - LIT_RAMP_S, atS], [0, 1]), interpolate(t, [to, to + LIT_RAMP_S], [1, 0]));
}

/** How lit slot element `target` is at beat-local `t`; 0 for an element no cue names after its reveal. */
export type Lit = (target: string, t: number) => number;

export function litFrom(emphases: Emphases): Lit {
  return (target, t) => Math.max(0, ...emphases.filter((e) => e.target === target).map((e) => litAt(t, e.atS)));
}

// The arch-map token's lit node: its brand tint and brand border, so every kind lights an element the same way.
const LIT_TINT = 0.25;
const LIT_RING_PX = 4;

/**
 * The lit treatment on an element's own box, over its `base` background: a brand tint and an inset brand ring that
 * take no layout space. Nothing while unlit, so an element no cue names draws as it always did.
 */
export function litBox(lit: number, base = "transparent"): { background?: string; boxShadow?: string } {
  if (lit <= 0) return {};
  return {
    background: mix(base, "var(--color-brand-primary)", lit * LIT_TINT),
    boxShadow: `inset 0 0 0 ${LIT_RING_PX}px ${mix("transparent", "var(--color-brand-primary)", lit)}`,
  };
}

const unlit: Lit = () => 0;

export const EmphasisContext = createContext<Lit>(unlit);

export const useLit = (): Lit => useContext(EmphasisContext);
