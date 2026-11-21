import { z } from "zod";
import type { CameraPathInput } from "./camera-path.js";

const BoxSchema = z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const Seconds = z.number().nonnegative();

const CameraTrackFileSchema = z.strictObject({
  schema: z.literal("explainer.camera-track/v1"),
  fps: z.number().positive(),
  sampleRateMultiple: z.number().int().positive(),
  // A free name: the camera layer that sampled the track declares it, and eval only records it.
  easeName: z.string().min(1),
  track: z.array(z.strictObject({ t: Seconds, box: BoxSchema })),
  beats: z.array(z.strictObject({ beatId: z.string(), startS: Seconds })),
  keyBoxes: z.array(z.strictObject({ id: z.string(), beatId: z.string(), box: BoxSchema, fromS: Seconds, toS: Seconds })),
  reveals: z.array(z.strictObject({ id: z.string(), beatId: z.string(), box: BoxSchema, fromS: Seconds, atS: Seconds })),
});

/** Parses an `explainer.camera-track/v1` file into the input the camera-path rows read; throws on any unknown field. */
export function readCameraTrack(json: unknown): CameraPathInput {
  const { track, beats, keyBoxes, reveals } = CameraTrackFileSchema.parse(json);
  return { track, beats, keyBoxes, reveals };
}
