/** What of a built layer the cue check reads: its source and the element ids it declares. */
export interface LayerElements {
  module: string;
  elements: readonly string[];
}

// A declared id the source never spells as a literal is an id the page cannot find when the cue fires.
const spelled = (module: string, id: string): boolean => [`"${id}"`, `'${id}'`, `\`${id}\``].some((literal) => module.includes(literal));

/** The ids a built layer exposes to its cues: those it lists in `elements` and spells as a string literal in its source. */
export const exposedElements = (layer: LayerElements): string[] => layer.elements.filter((id) => spelled(layer.module, id));

/** The cue targets a built layer does not expose, each once, in cue order. */
export function missingCueElements(targets: readonly string[], layer: LayerElements): string[] {
  const exposed = new Set(exposedElements(layer));
  return [...new Set(targets)].filter((target) => !exposed.has(target));
}

/** What a rebuild is told about the cue targets the first build missed, as a field of its packet. */
export const missingElementsHint = (missing: readonly string[]): string =>
  `the last build did not expose cue targets ${missing.join(", ")}: give each element a cue targets an id attribute equal to the target, spelled as a string literal, and list every target in elements`;
