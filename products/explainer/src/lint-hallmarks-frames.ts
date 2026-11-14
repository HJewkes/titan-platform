import { cappedRow, type GateRow } from "./writing-gate.js";
import type { WritingGatePolicy } from "./writing-gate-policy.js";

const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;

/** One spoken sentence with the beat and chapter it sits in. */
export interface HallmarkSentence {
  beat: string;
  chapter: string;
  text: string;
  words: number;
}

type Hallmarks = WritingGatePolicy["hallmarks"];

const leadWords = (text: string, n: number): string[] => (text.match(WORD) ?? []).slice(0, n).map((word) => word.toLowerCase().replace("’", "'"));

/** Sentences grouped by a key, in first-seen order. */
function grouped(sentences: readonly HallmarkSentence[], keyOf: (s: HallmarkSentence) => string | undefined): HallmarkSentence[][] {
  const groups = new Map<string, HallmarkSentence[]>();
  for (const sentence of sentences) {
    const key = keyOf(sentence);
    if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), sentence]);
  }
  return [...groups.values()];
}

/**
 * The frame refrain (TP-5721 #2): one opening frame of `frameWords` words that starts more than `max` sentences of one
 * chapter. The value is the most sentences any one frame opens in a chapter.
 */
export function frameRefrainRow(sentences: readonly HallmarkSentence[], rule: Hallmarks["frame-refrain"]): GateRow {
  const frameOf = (s: HallmarkSentence): string | undefined => {
    const lead = leadWords(s.text, rule.frameWords);
    return lead.length === rule.frameWords ? `${s.chapter}\u0000${lead.join(" ")}` : undefined;
  };
  const top = grouped(sentences, frameOf).sort((a, b) => b.length - a.length)[0] ?? [];
  return cappedRow("hallmark:frame-refrain", top.length, rule, top.map((s) => s.beat));
}

/** Runs of `run` or more short sentences in a row inside one beat that open on the same word. */
function recapRuns(sentences: readonly HallmarkSentence[], rule: Hallmarks["parallel-recap"]): HallmarkSentence[][] {
  const runs: HallmarkSentence[][] = [];
  let run: HallmarkSentence[] = [];
  const opener = (s: HallmarkSentence): string => leadWords(s.text, 1)[0] ?? "";
  for (const sentence of [...sentences, undefined]) {
    const continues = sentence !== undefined && sentence.words <= rule.maxWords && run.length > 0 && run[0]!.beat === sentence.beat && opener(run[0]!) === opener(sentence);
    if (continues) {
      run.push(sentence);
      continue;
    }
    if (run.length >= rule.run) runs.push(run);
    run = sentence !== undefined && sentence.words <= rule.maxWords ? [sentence] : [];
  }
  return runs;
}

/** The parallel recap (TP-5721 #8): the count of such runs. */
export function parallelRecapRow(sentences: readonly HallmarkSentence[], rule: Hallmarks["parallel-recap"]): GateRow {
  const runs = recapRuns(sentences, rule);
  return cappedRow("hallmark:parallel-recap", runs.length, rule, runs.flat().map((s) => s.beat));
}
