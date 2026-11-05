import { runFfmpeg } from "./ffmpeg.js";

export const SILENT_SAMPLE_RATE = 48_000;

/**
 * mix.wav of pure silence, `durationS` long to the sample, so a render with no narration still carries the AAC
 * track a player and the theater expect. Bit-exact flags keep two runs byte-identical.
 */
export async function silentMix(durationS: number, out: string): Promise<void> {
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`a silent mix needs a positive duration, got ${durationS}`);
  const samples = Math.round(durationS * SILENT_SAMPLE_RATE);
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `anullsrc=r=${SILENT_SAMPLE_RATE}:cl=mono`,
    "-af", `atrim=end_sample=${samples}`, "-c:a", "pcm_s16le",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
    out,
  ]);
}
