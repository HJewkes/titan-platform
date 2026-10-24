import { tmpdir } from "node:os";
import { spawnExec, type ExecResult } from "../workflow/bridge.js";

/** Runs one ffmpeg argv; tests may pass a fake, as the bridge's exec does. */
export type FfmpegExec = (argv: readonly string[]) => Promise<ExecResult>;

const TIMEOUT_MS = 300_000;

export const spawnFfmpeg: FfmpegExec = (argv) => spawnExec({ argv, cwd: tmpdir(), env: {}, timeoutMs: TIMEOUT_MS });

/** The library's one WAV shape: everything the mix reads is decoded from this. */
export const LIBRARY_SAMPLE_RATE = 48_000;

export interface Loudness {
  integratedLufs: number;
  truePeakDb: number;
}

async function run(exec: FfmpegExec, argv: readonly string[]): Promise<ExecResult> {
  const result = await exec(argv);
  if (result.code !== 0) {
    const last = result.stderr.trim().split(/\r?\n/).at(-1) ?? "";
    throw new Error(`${argv[0]} exited ${result.code}: ${last}`);
  }
  return result;
}

/** Decodes any input ffmpeg reads to mono 48 kHz PCM16, bit-exact so one input always gives one WAV sha. */
export async function normaliseToWav(input: string, output: string, exec: FfmpegExec = spawnFfmpeg): Promise<void> {
  await run(exec, [
    "ffmpeg", "-nostdin", "-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(LIBRARY_SAMPLE_RATE),
    "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "wav", output,
  ]);
}

const summaryValue = (summary: string, label: string): number => {
  const match = new RegExp(`${label}:\\s+(-?inf|-?[\\d.]+)`).exec(summary);
  if (!match) throw new Error(`ebur128 summary has no "${label}" line`);
  return match[1]!.endsWith("inf") ? -Infinity : Number(match[1]);
};

/** Integrated loudness and true peak from ffmpeg's `ebur128` summary; silence reads as -Infinity. */
export async function measureLoudness(file: string, exec: FfmpegExec = spawnFfmpeg): Promise<Loudness> {
  const { stderr } = await run(exec, ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) throw new Error("ebur128 printed no summary");
  const summary = stderr.slice(at);
  return { integratedLufs: summaryValue(summary, "I"), truePeakDb: summaryValue(summary, "Peak") };
}
