import type { ComponentType, ReactElement } from "react";
import type { z } from "zod";
import { BEAT_SLOTS } from "../beat-slots.js";
import { CatalogueBeat, CatalogueSlots } from "./beats/catalogue.js";
import { HeldBeat } from "./beats/held.js";
import { HookBeat } from "./beats/hook.js";
import { useReveal, type Reveal } from "./beats/stage/reveal.js";
import type { TimelineBeat } from "./timeline.js";

type BeatHints = NonNullable<TimelineBeat["hints"]>;

/** What a beat view draws from: its parsed slots, when each slot element lands, and the fill's page hints. */
export interface BeatViewProps<S> {
  slots: S;
  reveal: Reveal;
  hints: BeatHints;
}

/**
 * A beat kind: the schema its slots must satisfy, the component that draws them, and whether it sits in the stage
 * box under the chrome. A page kind (hook, catalogue) owns the whole canvas, as it did before the chrome existed.
 */
interface BeatDefinition {
  slots: z.ZodType;
  stage: boolean;
  render(slots: unknown, hints: BeatHints): ReactElement;
}

function defineBeat<S extends z.ZodType>(slots: S, Component: ComponentType<BeatViewProps<z.infer<S>>>, { stage = false } = {}): BeatDefinition {
  function Bound({ parsed, hints }: { parsed: z.infer<S>; hints: BeatHints }) {
    return <Component slots={parsed} reveal={useReveal()} hints={hints} />;
  }
  return { slots, stage, render: (raw, hints) => <Bound parsed={slots.parse(raw)} hints={hints} /> };
}

// Stands in for @titan-design/beats until TD-907 publishes it; the page then resolves kinds through that registry.
// Keyed by doctrine spec type, with the schema of the spec's slots ref (registry.test.ts checks every pairing).
// catalogue, the react-ui showcase, is no spec type.
const BEATS: Readonly<Record<string, BeatDefinition>> = {
  hook: defineBeat(BEAT_SLOTS.hook, HookBeat),
  held: defineBeat(BEAT_SLOTS.held, HeldBeat, { stage: true }),
  catalogue: defineBeat(CatalogueSlots, CatalogueBeat),
};

export const registeredKinds = (): string[] => Object.keys(BEATS);

export function resolveBeat(kind: string): BeatDefinition {
  const beat = Object.hasOwn(BEATS, kind) ? BEATS[kind] : undefined;
  if (!beat) throw new Error(`unknown beat kind "${kind}"; known kinds: ${Object.keys(BEATS).join(", ")}`);
  return beat;
}
