import type { ComponentType, ReactElement } from "react";
import type { z } from "zod";
import { BEAT_SLOTS } from "../beat-slots.js";
import { CatalogueBeat, CatalogueSlots } from "./beats/catalogue.js";
import { HookBeat } from "./beats/hook.js";

/** A beat kind: the schema its slots must satisfy and the component that draws them. */
interface BeatDefinition {
  slots: z.ZodType;
  render(slots: unknown): ReactElement;
}

function defineBeat<S extends z.ZodType>(slots: S, Component: ComponentType<{ slots: z.infer<S> }>): BeatDefinition {
  return { slots, render: (raw) => <Component slots={slots.parse(raw)} /> };
}

// Stands in for @titan-design/beats until TD-907 publishes it; the page then resolves kinds through that registry.
// A kind with a BEAT_SLOTS ref takes its schema from there; catalogue, the react-ui showcase, has none yet.
const BEATS: Readonly<Record<string, BeatDefinition>> = {
  hook: defineBeat(BEAT_SLOTS.hook, HookBeat),
  catalogue: defineBeat(CatalogueSlots, CatalogueBeat),
};

export function resolveBeat(kind: string): BeatDefinition {
  const beat = Object.hasOwn(BEATS, kind) ? BEATS[kind] : undefined;
  if (!beat) throw new Error(`unknown beat kind "${kind}"; known kinds: ${Object.keys(BEATS).join(", ")}`);
  return beat;
}
