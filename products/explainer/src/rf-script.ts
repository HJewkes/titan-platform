import { z } from "zod";

const Cue = z.object({ target: z.string(), atCue: z.string().optional() });
const Chip = z.object({ text: z.string() });
const MapSide = z.object({ item: z.object({ chips: z.array(Chip).nullish() }).nullish() });

// Separate from `SpikeScriptSchema` on purpose: the RF lints read keys the pace reader reports as ignored
// (`map_state.item`), and that reader's ignored list is part of its contract.
const RfScriptSchema = z.object({
  beats: z.array(
    z.object({
      id: z.string().min(1),
      chapter: z.string().min(1),
      function: z.string(),
      plannedS: z.number().nonnegative(),
      spoken: z.string(),
      origin: z.string().optional(),
      visual: z.object({
        render: z.string(),
        cues: z.array(Cue).default([]),
        map_state: MapSide.extend({ map: z.string().optional(), old: MapSide.nullish(), new: MapSide.nullish() }).nullish(),
      }),
    }),
  ),
});

export type RfScript = z.infer<typeof RfScriptSchema>;
export type RfBeat = RfScript["beats"][number];
type RfMapState = NonNullable<RfBeat["visual"]["map_state"]>;

/** One issue as `build_script.py --lint` prints it; `beat` is null for a whole-script check. */
export interface RfIssue {
  beat: string | null;
  check: string;
  severity: "error" | "warn";
  message: string;
}

/** Reads a Python-emitted spike script.json for the RF lints, keeping only the keys they read. */
export const readRfScript = (json: unknown): RfScript => RfScriptSchema.parse(json);

/** Each map side a map_state draws: one, or both halves of a split (build_script.py `map_sides`). */
export function mapSides(state: RfMapState | null | undefined): z.infer<typeof MapSide>[] {
  if (!state) return [{}];
  if (state.map !== "split") return [state];
  return [state.old, state.new].filter((side): side is z.infer<typeof MapSide> => Boolean(side));
}
