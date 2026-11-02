import type { LayerPacket } from "./layer-packet.js";

/** One cue word a layer never reads through `useCue`, with the targets it times. */
export interface UntimedCue {
  cue: string;
  targets: string[];
}

const USE_CUE = /\buseCue\(\s*(["'`])(.+?)\1\s*\)/g;

/** Every cue name the source reads as `useCue("<name>")`. */
const cuesRead = (module: string): Set<string> => new Set([...module.matchAll(USE_CUE)].map((match) => match[2]!));

/**
 * The packet's cue words the layer does not read with `useCue`, each once, in cue order. The voice moves every cue
 * word, so a target timed from a literal second lands wherever the plan put it, not on its word.
 */
export function untimedCues(module: string, cues: LayerPacket["cues"]): UntimedCue[] {
  const read = cuesRead(module);
  const untimed = new Map<string, string[]>();
  for (const { target, atCue, untilCue } of cues) {
    for (const cue of untilCue ? [atCue, untilCue] : [atCue]) {
      if (!read.has(cue)) untimed.set(cue, [...new Set([...(untimed.get(cue) ?? []), target])]);
    }
  }
  return [...untimed].map(([cue, targets]) => ({ cue, targets }));
}

export const formatUntimed = (untimed: readonly UntimedCue[]): string =>
  untimed.map(({ cue, targets }) => `"${cue}" (${targets.join(", ")})`).join(", ");

/** What a rebuild is told about the cue words the last build timed from its own seconds, as a field of its packet. */
export const untimedCueHint = (untimed: readonly UntimedCue[]): string =>
  `the last build timed cue targets from literal seconds, not their cue words: ${formatUntimed(untimed)}: ` +
  `read each cue's second with useCue, as const at = useCue("${untimed[0]?.cue ?? "<cue word>"}"), and start its target's change from it; ` +
  "write no cue's second as a number, because the voice moves every cue word";
