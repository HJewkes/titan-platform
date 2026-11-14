import { z } from "zod";

/** A chapter of the rendered video, in video seconds; `n` and `title` are the script's, as the chapter card shows them. */
export const ChapterSchema = z.strictObject({
  id: z.string().min(1),
  n: z.number().int().positive(),
  title: z.string(),
  startS: z.number().nonnegative(),
  endS: z.number().positive(),
});
export type Chapter = z.infer<typeof ChapterSchema>;

/** A timeline beat with its script chapter; a page extra that belongs to no chapter has none. */
export interface ChapterBeat {
  chapter?: string;
  startS: number;
  durationS: number;
}

const ms = (s: number): number => Math.round(s * 1000) / 1000;

/** Where each chapter's first beat opens, in play order; a chapter that opens twice has beats split around another. */
function chapterOpens(beats: readonly ChapterBeat[]): Map<string, number> {
  const opens = new Map<string, number>();
  let current: string | undefined;
  for (const beat of beats) {
    if (beat.chapter === undefined || beat.chapter === current) continue;
    if (opens.has(beat.chapter)) throw new Error(`chapter "${beat.chapter}" opens again at ${beat.startS} s after another chapter; its beats must play together`);
    opens.set(beat.chapter, beat.startS);
    current = beat.chapter;
  }
  return opens;
}

/**
 * The port of the spike's `chapters.ts`, over the compiled timeline instead of words.json. The first chapter opens at
 * 0 and each one ends where the next opens, so the list tiles the video as YouTube chapters must; a chapter whose
 * beats resolve cut all away is left out.
 */
export function layoutChapters(chapters: readonly { id: string; label: string }[], beats: readonly ChapterBeat[]): Chapter[] {
  const index = new Map(chapters.map((chapter, i) => [chapter.id, { n: i + 1, title: chapter.label }]));
  const opens = [...chapterOpens(beats)].map(([id, startS]) => {
    const known = index.get(id);
    if (known === undefined) throw new Error(`a beat names chapter "${id}", which the script does not list`);
    return { id, ...known, startS: ms(startS) };
  });
  const endS = ms(beats.reduce((end, beat) => Math.max(end, beat.startS + beat.durationS), 0));
  return opens.map((chapter, i) => ({ ...chapter, startS: i === 0 ? 0 : chapter.startS, endS: opens[i + 1]?.startS ?? endS }));
}
