import type { ProbedMoment } from "@titan-design/render-qa";
import type { LayerTextRow } from "../build/layer-text.js";
import { contentFill, MIN_CONTENT_FILL } from "../content-fill.js";
import { FRAME_WORDS, frameWords } from "./timing-gates.js";

/** qa's content-fill gate on the layer's settled frame: its content spans under 60 % of the frame width. */
export function contentFillRows(beat: string, settled: Pick<ProbedMoment, "t" | "boxes">, frame: { width: number; height: number }): LayerTextRow[] {
  const fill = contentFill({ beat, t: settled.t, boxes: settled.boxes }, frame);
  return fill >= MIN_CONTENT_FILL ? [] : [{ beat, element: "stage", rule: "content-fill", text: `${Math.round(fill * 100)} % of the frame width`, atS: settled.t }];
}

/** qa's words-per-frame gate on every probed frame of the layer, as one row at the frame with the most words. */
export function frameWordRows(beat: string, probed: readonly Pick<ProbedMoment, "t" | "texts">[]): LayerTextRow[] {
  const counts = probed.map(({ t, texts }) => ({ t, n: frameWords(texts) })).filter(({ n }) => n > FRAME_WORDS);
  const most = counts.reduce<(typeof counts)[number] | undefined>((top, count) => (top === undefined || count.n > top.n ? count : top), undefined);
  return most ? [{ beat, element: "frame", rule: "words-per-frame", text: `${most.n} words on screen`, atS: most.t }] : [];
}
