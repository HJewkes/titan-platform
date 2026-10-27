import type { ComponentType, ReactElement } from "react";
import type { z } from "zod";
import { BEAT_SLOTS } from "../beat-slots.js";
import { CatalogueBeat, CatalogueSlots } from "./beats/catalogue.js";
import { ArchMapKindBeat } from "./beats/ArchMapBeat.js";
import { ChartKindBeat } from "./beats/ChartBeat.js";
import { CompareKindBeat } from "./beats/CompareBeat.js";
import { HeldBeat } from "./beats/held.js";
import { HookBeat } from "./beats/hook.js";
import { FactFlashBeat, ListKindBeat, VerdictCardBeat } from "./beats/list-kinds.js";
import { ButtonBeat, OutroKindBeat } from "./beats/OutroBeat.js";
import { StatKindBeat } from "./beats/StatBeat.js";
import { ClaimCardBeat } from "./beats/TitleBeat.js";
import { useReveal, type Reveal } from "./beats/stage/reveal.js";
import type { TimelineBeat } from "./timeline.js";

type BeatHints = NonNullable<TimelineBeat["hints"]>;

/** What a view reads off its timeline beat beside the slots: the fill's page hints and the chapter label. */
interface BeatContext {
  hints: BeatHints;
  chapter?: string;
}

/** What a beat view draws from: its parsed slots, when each slot element lands, the fill's hints and the chapter label. */
export interface BeatViewProps<S> extends BeatContext {
  slots: S;
  reveal: Reveal;
}

/**
 * A beat kind: the schema its slots must satisfy, the component that draws them, whether it sits in the stage box
 * under the chrome, and whether the chrome shows the headline over it. A page kind (hook, catalogue) owns the whole
 * canvas, as it did before the chrome existed. A title or outro is its own headline, as the spike's NO_HEADLINE kept.
 */
interface BeatDefinition {
  slots: z.ZodType;
  stage: boolean;
  headline: boolean;
  render(slots: unknown, context: BeatContext): ReactElement;
}

function defineBeat<S extends z.ZodType>(slots: S, Component: ComponentType<BeatViewProps<z.infer<S>>>, { stage = false, headline = true } = {}): BeatDefinition {
  function Bound({ parsed, context }: { parsed: z.infer<S>; context: BeatContext }) {
    return <Component slots={parsed} reveal={useReveal()} {...context} />;
  }
  return { slots, stage, headline, render: (raw, context) => <Bound parsed={slots.parse(raw)} context={context} /> };
}

// Stands in for @titan-design/beats until TD-907 publishes it; the page then resolves kinds through that registry.
// Keyed by doctrine spec type, with the schema of the spec's slots ref (registry.test.ts checks every pairing).
// catalogue, the react-ui showcase, is no spec type.
const BEATS: Readonly<Record<string, BeatDefinition>> = {
  hook: defineBeat(BEAT_SLOTS.hook, HookBeat),
  held: defineBeat(BEAT_SLOTS.held, HeldBeat, { stage: true }),
  list: defineBeat(BEAT_SLOTS.list, ListKindBeat, { stage: true }),
  "verdict-card": defineBeat(BEAT_SLOTS["verdict-card"], VerdictCardBeat, { stage: true }),
  "fact-flash": defineBeat(BEAT_SLOTS["fact-flash"], FactFlashBeat, { stage: true }),
  "claim-card": defineBeat(BEAT_SLOTS["claim-card"], ClaimCardBeat, { stage: true, headline: false }),
  button: defineBeat(BEAT_SLOTS.button, ButtonBeat, { stage: true, headline: false }),
  outro: defineBeat(BEAT_SLOTS.outro, OutroKindBeat, { stage: true, headline: false }),
  stat: defineBeat(BEAT_SLOTS.stat, StatKindBeat, { stage: true }),
  chart: defineBeat(BEAT_SLOTS.chart, ChartKindBeat, { stage: true }),
  compare: defineBeat(BEAT_SLOTS.compare, CompareKindBeat, { stage: true }),
  "arch-map": defineBeat(BEAT_SLOTS.map, ArchMapKindBeat, { stage: true }),
  catalogue: defineBeat(CatalogueSlots, CatalogueBeat),
};

export const registeredKinds = (): string[] => Object.keys(BEATS);

export function resolveBeat(kind: string): BeatDefinition {
  const beat = Object.hasOwn(BEATS, kind) ? BEATS[kind] : undefined;
  if (!beat) throw new Error(`unknown beat kind "${kind}"; known kinds: ${Object.keys(BEATS).join(", ")}`);
  return beat;
}
