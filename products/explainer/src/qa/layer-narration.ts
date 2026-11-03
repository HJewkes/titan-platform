import type { ProbedMoment } from "@titan-design/render-qa";
import { plainText } from "@titan-design/speech-vet";
import type { LayerTextRow } from "../build/layer-text.js";
import { unspokenFacts } from "./narration-facts.js";
import { SHARED_RUN_WORDS, sharedRun } from "./timing-gates.js";

type ProbedTexts = Pick<ProbedMoment, "t" | "texts">;

/**
 * qa's narration rules on one layer, against the words its beat speaks: a number or headline name the settled frame
 * shows that the narration never says, read at the last moment so a count-up is judged on the value it lands on, and
 * any text that repeats 5 or more narration words in a row.
 */
export function narrationRows(beat: string, spoken: string, probed: readonly ProbedTexts[]): LayerTextRow[] {
  const heard = plainText(spoken);
  const settled = [...probed].sort((a, b) => a.t - b.t).at(-1);
  const facts = settled === undefined ? [] : unspokenFacts(beat, settled.texts, heard).map((fact): LayerTextRow => {
    const shown = settled.texts.find(({ text }) => text === fact.shown)!;
    return { beat, element: shown.element, rule: "unspoken-fact", text: shown.text, atS: settled.t, fact: fact.fact };
  });
  const echoes = probed.flatMap(({ t, texts }) => texts.filter(({ text }) => sharedRun(text, heard) >= SHARED_RUN_WORDS)
    .map(({ element, text }): LayerTextRow => ({ beat, element, rule: "narration-echo", text, atS: t })));
  return [...facts, ...echoes];
}
