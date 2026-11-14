import { z } from "zod";

export const TRACKS = ["r", "i", "p"] as const;
export type Track = (typeof TRACKS)[number];

const ArmSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "an arm id names a directory, so it uses [A-Za-z0-9._-] only"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  pilotOnly: z.boolean().optional(),
});
export type Arm = z.infer<typeof ArmSchema>;

const ArmList = z.array(ArmSchema).min(1).refine((arms) => new Set(arms.map((arm) => arm.id)).size === arms.length, "arm ids must be unique");

export function parseArms(json: unknown): Arm[] {
  return ArmList.parse(json);
}

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

const arm = (id: string, model: string, effort: Arm["effort"], pilotOnly?: true): Arm => ({ id, model, effort, ...(pilotOnly && { pilotOnly }) });

/** The design's kept arms per track; I's F-high runs in the pilot only (coordinator decision for S1). */
export const TRACK_ARMS: Record<Track, readonly Arm[]> = {
  r: [
    arm("F-high", FABLE, "high"),
    arm("O-high", OPUS, "high"),
    arm("O-med", OPUS, "medium"),
    arm("S-high", SONNET, "high"),
    arm("S-med", SONNET, "medium"),
    arm("H-high", HAIKU, "high"),
    arm("H-med", HAIKU, "medium"),
  ],
  i: [arm("O-med", OPUS, "medium"), arm("S-high", SONNET, "high"), arm("S-med", SONNET, "medium"), arm("H-high", HAIKU, "high"), arm("F-high", FABLE, "high", true)],
  p: [arm("F-high", FABLE, "high"), arm("O-high", OPUS, "high"), arm("O-med", OPUS, "medium"), arm("S-high", SONNET, "high"), arm("H-high", HAIKU, "high")],
};

export function defaultArms(track: Track, pilot: boolean): Arm[] {
  return TRACK_ARMS[track].filter((entry) => pilot || entry.pilotOnly !== true);
}
