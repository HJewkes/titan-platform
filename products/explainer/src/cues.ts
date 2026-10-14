/** One spoken word and its start, in seconds from the beat start (a words.json entry). */
export interface WordTiming {
  word: string;
  startS: number;
}

/** Resolves a beat's cue ("word" or "word#n") to seconds from that beat's start. */
export type CueResolver = (beatId: string, cue: string) => number;

const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");

/** A resolver over per-beat word timings. An unknown cue throws: a cue never falls back to a guess. */
export function cueResolverFromWords(words: Readonly<Record<string, readonly WordTiming[]>>): CueResolver {
  return (beatId, cue) => {
    const [word = "", nth = "1"] = cue.split("#");
    const target = normalize(word);
    const hits = (words[beatId] ?? []).filter((w) => normalize(w.word) === target);
    const hit = hits[Number(nth) - 1];
    if (!hit) throw new Error(`cue "${cue}" is not spoken in ${beatId}`);
    return hit.startS;
  };
}
