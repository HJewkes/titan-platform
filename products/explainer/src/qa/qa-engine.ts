import { launch } from "@titan-design/frame-capture";
import { inspectAt, openQaPage, writeCrops, type CroppedFinding, type CueRecord, type FrameInspection, type InspectOptions } from "@titan-design/render-qa";
import { ffmpegMedia, type MediaExec } from "../workflow/sheets-stage.js";

/** One page the qa stage inspects: seek-and-inspect, crops of held errors, then close. */
export interface QaPage {
  inspectAt(t: number, options: InspectOptions): Promise<FrameInspection>;
  /** Writes an annotated crop per held error into `dir` and sets each one's `crop`. */
  crops(errors: CroppedFinding[], dir: string, options: InspectOptions): Promise<void>;
  close(): Promise<void>;
}

/** The qa stage's outside world: a browser on the served page and ffprobe on the MP4. Workflow tests pass a fake. */
export interface QaEngine {
  open(url: string, options: InspectOptions, cues: CueRecord[]): Promise<QaPage>;
  durationS: MediaExec["durationS"];
}

/** Real Chromium through frame-capture and render-qa, and the host's ffprobe. */
export function chromiumQaEngine(media: Pick<MediaExec, "durationS"> = ffmpegMedia()): QaEngine {
  return {
    async open(url, options, cues) {
      const browser = await launch();
      try {
        const { page } = await openQaPage(browser, url, { width: options.W, height: options.H }, cues);
        return {
          inspectAt: (t, opts) => inspectAt(page, t, opts),
          crops: (errors, dir, opts) => writeCrops(browser, url, errors, dir, opts),
          close: () => browser.close(),
        };
      } catch (error) {
        await browser.close();
        throw error;
      }
    },
    durationS: (mp4) => media.durationS(mp4),
  };
}
