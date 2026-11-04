import { createContext, useContext } from "react";
import type { TimelineBeat } from "../../timeline.js";

type Reveals = NonNullable<TimelineBeat["reveals"]>;
type RevealPart = Reveals[number]["part"];

/**
 * Seconds from the beat's start at which slot element `target` (one compare side, with `part`) lands on its cue
 * word. Undefined when the timeline gives that element no cue; the view then picks its own entrance.
 */
export type Reveal = (target: string, part?: RevealPart) => number | undefined;

export function revealFrom(reveals: Reveals): Reveal {
  return (target, part) => reveals.find((r) => r.target === target && r.part === part)?.atS;
}

const noReveals: Reveal = () => undefined;

export const RevealContext = createContext<Reveal>(noReveals);

export const useReveal = (): Reveal => useContext(RevealContext);
