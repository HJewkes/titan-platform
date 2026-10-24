import { execFileSync } from "node:child_process";
import type { RenderTimeline } from "./render-video.js";

/** A synthetic tone, made at test time so no audio is committed. */
export function sineWav(out: string, durationS: number, frequency = 440): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=24000:duration=${durationS}`, out]);
}

/** One solid-colour PNG frame. */
export function pngFrame(out: string, colour = "blue"): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=64x36`, "-frames:v", "1", out]);
}

export interface ProbedStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  nb_read_frames?: string;
  nb_read_packets?: string;
  sample_rate?: string;
  duration_ts?: number;
}

export function probeStreams(file: string): ProbedStream[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames,sample_rate,duration_ts", "-of", "json", file], { encoding: "utf8" });
  return (JSON.parse(out) as { streams: ProbedStream[] }).streams;
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
