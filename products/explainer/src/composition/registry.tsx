import type { ComponentType, ReactElement } from "react";
import type { z } from "zod";
import { CatalogueBeat, CatalogueSlots } from "./beats/catalogue.js";
import { TitleBeat, TitleSlots } from "./beats/title.js";

/** A beat kind: the schema its slots must satisfy and the component that draws them. */
export interface BeatDefinition {
  slots: z.ZodType;
  render(slots: unknown): ReactElement;
}

function defineBeat<S extends z.ZodType>(slots: S, Component: ComponentType<{ slots: z.infer<S> }>): BeatDefinition {
  return { slots, render: (raw) => <Component slots={slots.parse(raw)} /> };
}

// Stands in for @titan-design/beats until TD-907 publishes it; the page then resolves kinds through that registry.
export const BEATS: Readonly<Record<string, BeatDefinition>> = {
  title: defineBeat(TitleSlots, TitleBeat),
  catalogue: defineBeat(CatalogueSlots, CatalogueBeat),
};

export function resolveBeat(kind: string): BeatDefinition {
  const beat = Object.hasOwn(BEATS, kind) ? BEATS[kind] : undefined;
  if (!beat) throw new Error(`unknown beat kind "${kind}"; known kinds: ${Object.keys(BEATS).join(", ")}`);
  return beat;
}
