import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { RenderHost } from "./render-manifest.js";
import type { RenderDeps, RenderTimeline } from "./render-video.js";

/** A stage-fit scan that finds every beat inside its stage box, for renders with no real page behind them. */
export const fitsStage: RenderDeps["stageFit"] = async () => [];

export const FAKE_HOST: RenderHost = {
  platform: "linux", arch: "x64", cpuModel: "Synthetic CPU", cpus: 4, node: "v0.0.0", ffmpeg: "ffmpeg version 0", chromium: "0.0.0.0",
};

/** A synthetic tone, made at test time so no audio is committed. */
export function sineWav(out: string, durationS: number, frequency = 440): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=24000:duration=${durationS}`, out]);
}

/** One solid-colour PNG frame. */
export function pngFrame(out: string, colour = "blue"): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=64x36`, "-frames:v", "1", out]);
}

const ProbedStreamsSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(),
    codec_name: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    nb_read_frames: z.string().optional(),
    sample_rate: z.string().optional(),
    duration_ts: z.number().optional(),
  })),
});
type ProbedStream = z.infer<typeof ProbedStreamsSchema>["streams"][number];

export function probeStreams(file: string): ProbedStream[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames,sample_rate,duration_ts", "-of", "json", file], { encoding: "utf8" });
  return ProbedStreamsSchema.parse(JSON.parse(out)).streams;
}

/** Beats laid end to end from their durations. */
export function timelineOf(durations: readonly number[], provisional = false): RenderTimeline {
  let startS = 0;
  const beats = durations.map((durationS, i) => {
    const beat = { id: `beat-${i + 1}`, startS, durationS };
    startS += durationS;
    return beat;
  });
  return { durationS: startS, provisional, beats };
}

/** Stands in for the browser: emits `png` for every frame asked for and reports the page length it is given. */
export function framesOf(png: Buffer, pageDurationS?: (frames: number, fps: number) => number): RenderDeps["captureFrames"] {
  return async (options, sink) => {
    const frames = options.frames ?? 0;
    for (let i = 0; i < frames; i++) await sink(i, png);
    return { frames, pageDurationS: pageDurationS ? pageDurationS(frames, options.fps) : frames / options.fps, fonts: [] };
  };
}
