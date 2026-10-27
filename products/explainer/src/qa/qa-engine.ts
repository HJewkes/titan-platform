import { launch } from "@titan-design/frame-capture";
import {
  frameDiffs,
  inspectAt,
  mediaScan,
  openQaPage,
  probeMoments,
  writeCrops,
  type CroppedFinding,
  type CueRecord,
  type FrameInspection,
  type InspectOptions,
  type MediaScan,
  type ProbeAt,
  type ProbedMoment,
} from "@titan-design/render-qa";
import { ffmpegMedia, type MediaExec } from "../workflow/sheets-stage.js";

/** One page the qa stage inspects: seek-and-inspect, the DOM probe, crops of held errors, then close. */
export interface QaPage {
  inspectAt(t: number, options: InspectOptions): Promise<FrameInspection>;
  probe(moments: readonly ProbeAt[]): Promise<ProbedMoment[]>;
  /** Writes an annotated crop per held error into `dir` and sets each one's `crop`. */
  crops(errors: CroppedFinding[], dir: string, options: InspectOptions): Promise<void>;
  close(): Promise<void>;
}

/** The qa stage's outside world: a browser on the served page, and ffprobe and ffmpeg on the MP4. Workflow tests pass a fake. */
export interface QaEngine {
  open(url: string, options: InspectOptions, cues: CueRecord[]): Promise<QaPage>;
  durationS: MediaExec["durationS"];
  /** The share of pixels each frame changed from the one before (render-qa's `frameDiffs`). */
  frameDiffs(mp4: string): Promise<number[]>;
  /** Black, silent (2 s and more) and frozen stretches of the MP4 (render-qa's `mediaScan`). */
  mediaScan(mp4: string): Promise<MediaScan>;
}

/** Real Chromium through frame-capture and render-qa, and the host's ffprobe and ffmpeg. */
export function chromiumQaEngine(media: Pick<MediaExec, "durationS"> = ffmpegMedia()): QaEngine {
  return {
    async open(url, options, cues) {
      const browser = await launch();
      try {
        const { page } = await openQaPage(browser, url, { width: options.W, height: options.H }, cues);
        return {
          inspectAt: (t, opts) => inspectAt(page, t, opts),
          probe: (moments) => probeMoments(page, moments),
          crops: (errors, dir, opts) => writeCrops(browser, url, errors, dir, opts),
          close: () => browser.close(),
        };
      } catch (error) {
        await browser.close();
        throw error;
      }
    },
    durationS: (mp4) => media.durationS(mp4),
    frameDiffs: (mp4) => frameDiffs(mp4),
    mediaScan: (mp4) => mediaScan(mp4),
  };
}
