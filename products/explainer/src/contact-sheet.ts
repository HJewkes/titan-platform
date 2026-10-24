import { z } from "zod";

/**
 * Beat-aware contact-sheet cut points (contact-sheets research §2.2). Every cell comes from data the render already
 * writes: beat bounds, each cue's measured beat-local time, and the beat's component. No clock time and no pixels are
 * involved, so lengthening a beat moves no cell off the picture it was cut for. A page that publishes its own marks
 * (`__titanMotion.marks()`, TP-4017) is cut one cell per mark instead.
 */

/** fadeUp takes 0.5 s; a ListBeat tick lands 0.15 s later and eases 0.5 s. Matches the cue gate's AFTER_CUE_S. */
export const SETTLE_S = 0.9;
export const END_BACKOFF_S = 0.2;
export const OUTRO_EXIT_S = 1.2;
export const BEFORE_CUE_S = 0.1;
/** A focus beat shows its whole view before the first cue only when that view has had time to settle. */
export const MIN_BEFORE_S = 1.5;

export const SHEET_RULES = ["hero", "hero-before-exit", "build", "swap", "focus", "steps", "marks"] as const;
export type SheetRule = (typeof SHEET_RULES)[number];

const BUILD = new Set(["ListBeat", "StatBeat", "HookBeat", "CompareBeat", "ArchMapBeat", "WalkBeat", "ImageBeat", "ChecklistBeat"]);
// The focus bar moves and the rest dims, so the unfocused view is a picture of its own.
const FOCUS = new Set(["CodeWalkBeat"]);

export const RenderTimelineSchema = z.object({ beats: z.array(z.object({ id: z.string(), startS: z.number(), durationS: z.number().positive() })) });
export const CueTimesSchema = z.object({ cues: z.array(z.object({ beat: z.string(), atS: z.number() })) });
/** The visual track: `render` in visual.json, `kind` in a sample; `placeholder`/`heading` mark a question swapped for rows. */
export const SheetVisualSchema = z.object({
  beats: z.array(z.object({
    id: z.string(),
    chapter: z.string().optional(),
    render: z.string().optional(),
    kind: z.string().optional(),
    placeholder: z.unknown().optional(),
    heading: z.unknown().optional(),
  })),
});
export const MARK_KINDS = ["settled", "step", "before", "transform-start", "transform-end", "hero"] as const;
export const PageMarksSchema = z.array(z.object({ t: z.number(), beat: z.string(), kind: z.enum(MARK_KINDS) }));

export type RenderTimeline = z.infer<typeof RenderTimelineSchema>;
export type CueTimes = z.infer<typeof CueTimesSchema>;
export type SheetVisual = z.infer<typeof SheetVisualSchema>;
/** One page mark, `t` in video seconds as the protocol reports it. */
export type PageMark = z.infer<typeof PageMarksSchema>[number];
type VisualBeat = SheetVisual["beats"][number];

export interface SheetInput {
  render: RenderTimeline;
  cues: CueTimes;
  visual: SheetVisual;
  marks?: readonly PageMark[];
}

export interface SheetCell {
  /** `<beat>/<tag>`: stable across re-timings, so two cuts compare cell by cell. */
  key: string;
  beat: string;
  chapter: string;
  rule: SheetRule;
  tag: string;
  /** Seconds from the beat's start. */
  local: number;
  /** Seconds from the video's start. */
  t: number;
  /** The text of the strip under the frame. */
  label: string;
}

type Cut = { tag: string; local: number };

export function sheetRule(beat: VisualBeat | undefined): Exclude<SheetRule, "marks"> {
  const component = beat?.render ?? beat?.kind ?? "";
  if (component === "TitleBeat") return "hero";
  if (component === "OutroBeat") return "hero-before-exit";
  if (beat?.placeholder || beat?.heading) return "swap";
  if (BUILD.has(component)) return "build";
  return FOCUS.has(component) ? "focus" : "steps";
}

/** Each cue at its settled state, but never past the moment before the next cue starts changing the picture. */
function stepCuts(cues: readonly number[], last: number): Cut[] {
  return cues.map((at, i) => {
    const next = i + 1 < cues.length ? cues[i + 1]! - BEFORE_CUE_S : last;
    return { tag: `step${i + 1}`, local: Math.min(at + SETTLE_S, next, last) };
  });
}

function ruleCuts(rule: Exclude<SheetRule, "marks">, durationS: number, cues: readonly number[]): Cut[] {
  const last = durationS - END_BACKOFF_S;
  const settled: Cut = { tag: "settled", local: last };
  const first = cues[0];
  if (rule === "hero") return [{ tag: "hero", local: last }];
  if (rule === "hero-before-exit") return [{ tag: "hero", local: Math.max(SETTLE_S, durationS - OUTRO_EXIT_S) }];
  if (rule === "build") return [settled];
  // The question must have settled before the first row replaces it, or there is no before picture to show.
  if (rule === "swap") return first !== undefined && first - BEFORE_CUE_S >= SETTLE_S ? [{ tag: "before", local: first - BEFORE_CUE_S }, settled] : [settled];
  const before = rule === "focus" && first !== undefined && first >= MIN_BEFORE_S ? [{ tag: "before", local: first - BEFORE_CUE_S }] : [];
  const steps = [...before, ...stepCuts(cues, last)];
  return steps.length > 0 ? steps : [settled];
}

function markCuts(marks: readonly PageMark[], startS: number): Cut[] {
  const seen = new Map<string, number>();
  return [...marks].sort((a, b) => a.t - b.t).map((mark) => {
    const n = (seen.get(mark.kind) ?? 0) + 1;
    seen.set(mark.kind, n);
    return { tag: `${mark.kind}${n}`, local: mark.t - startS };
  });
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Every cell of the sheet, in video order: one beat's cells from its marks when the page publishes any, else §2.2. */
export function cutCells(input: SheetInput): SheetCell[] {
  const visual = new Map(input.visual.beats.map((beat) => [beat.id, beat]));
  return input.render.beats.flatMap((beat) => {
    const meta = visual.get(beat.id);
    const marks = (input.marks ?? []).filter((mark) => mark.beat === beat.id);
    const cues = input.cues.cues.filter((cue) => cue.beat === beat.id).map((cue) => cue.atS).sort((a, b) => a - b);
    const rule: SheetRule = marks.length > 0 ? "marks" : sheetRule(meta);
    const cuts = rule === "marks" ? markCuts(marks, beat.startS) : ruleCuts(rule, beat.durationS, cues);
    return cuts.map(({ tag, local }): SheetCell => {
      const t = round3(beat.startS + local);
      return { key: `${beat.id}/${tag}`, beat: beat.id, chapter: meta?.chapter ?? "all", rule, tag, local: round3(local), t, label: `${beat.id} ${rule} ${tag} ${t.toFixed(1)}s` };
    });
  });
}

/** Cells grouped into one sheet per chapter, chapters in the order they first appear. */
export function chapterSheets<C extends Pick<SheetCell, "chapter">>(cells: readonly C[]): { chapter: string; cells: C[] }[] {
  const sheets = new Map<string, C[]>();
  for (const cell of cells) sheets.set(cell.chapter, [...(sheets.get(cell.chapter) ?? []), cell]);
  return [...sheets].map(([chapter, group]) => ({ chapter, cells: group }));
}
