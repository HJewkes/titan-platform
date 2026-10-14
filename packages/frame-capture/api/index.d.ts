import { Page, Browser } from 'playwright-core';

/**
 * The only contract between a capture and the page it captures. The page publishes this object as
 * `window.__titanMotion`; the capture never imports the page's code. The shape matches titan-design's
 * `TitanMotionApi` (react-ui `/motion`, `MotionProvider` on a `seekClock`), but any page that sets
 * the global can be captured.
 */
interface TitanMotionApi {
    /** Shows the frame at `t` seconds. It must commit synchronously: the capture screenshots after `ready()`. */
    seek(t: number): void;
    /** Resolves once the frame `seek` committed has nothing left to load (fonts, images, pending data). */
    ready(): Promise<void>;
    /** The timeline length in seconds; the capture renders `duration * fps` frames unless told otherwise. */
    readonly duration: number;
}
/** The global the page publishes `TitanMotionApi` under. */
declare const TITAN_MOTION_GLOBAL = "__titanMotion";

/**
 * The virtual-time init script. Playwright runs it before any page script, so nothing in
 * the page reads real time: Date, performance.now, timers and rAF all follow a clock that only
 * `__virtualTime.advanceTo(ms)` moves, and Math.random is seeded.
 *
 * Each step below is serialised on its own, so it must stay self-contained: no imports, no closures over
 * module scope, and no calls to another step except through the `steps` it is handed. Passing the steps
 * in, rather than calling them by name, keeps the script working if a bundler renames a function.
 */
/** The init script source, for `context.addInitScript({ content: VIRTUAL_TIME_SCRIPT })`. */
declare const VIRTUAL_TIME_SCRIPT: string;
interface VirtualTimeApi {
    now(): number;
    pending(): {
        timers: number;
        rafs: number;
    };
    /** Fires every timer due by `ms` in order, sets the clock to `ms`, then runs one rAF frame. */
    advanceTo(ms: number): void;
}

declare global {
    interface Window {
        __virtualTime: VirtualTimeApi;
        __titanMotion?: TitanMotionApi;
    }
}
interface Viewport {
    width: number;
    height: number;
}
interface PageOptions extends Viewport {
    /** Load every declared FontFace before frame 0. Off only to measure what it prevents. */
    preloadFonts?: boolean;
}
interface FontState {
    family: string;
    status: string;
}
declare function launch(): Promise<Browser>;
/**
 * Loads the page's fonts and waits on document.fonts.ready. The explicit load matters: fonts load
 * lazily on first use, so fonts.ready alone can resolve before a beat that mounts later asks for one.
 * A face that fails to load is left in its `error` status for the caller, which can name it; the
 * rejection itself says only "A network error occurred".
 */
declare function settleFonts(page: Page, preload?: boolean): Promise<FontState[]>;
interface CapturePage {
    page: Page;
    /** `__titanMotion.duration` in seconds. */
    duration: number;
    fonts: FontState[];
    /** Every uncaught page error, collected from before navigation; empty when the open succeeds. */
    errors: readonly Error[];
}
/**
 * The pageerror listener attaches before navigation: an error thrown while the page loads, such as a
 * render that throws on mount, leaves a page that still answers seeks and screenshots blank.
 */
declare function openCapturePage(browser: Browser, url: string, options: PageOptions): Promise<CapturePage>;
/** One frame: advance virtual time, seek (commits through flushSync), await ready(), screenshot. */
declare function captureFrame(page: Page, t: number): Promise<Buffer>;

interface FramesOptions extends PageOptions {
    url: string;
    fps: number;
    /** Frame count; defaults to the page's duration times fps. */
    frames?: number;
    /**
     * Pages capturing contiguous chunks in parallel. A fixed count renders byte-identically run to run,
     * but a chunk's first frames can differ from a sequential render by a few levels of anti-aliasing.
     */
    workers?: number;
}
interface FramesResult {
    frames: number;
    /** `__titanMotion.duration`: the page's own idea of the timeline length. */
    pageDurationS: number;
    fonts: CapturePage['fonts'];
}
type Sink = (index: number, png: Buffer) => Promise<void>;
declare function captureFrames(options: FramesOptions, sink: Sink): Promise<FramesResult>;

/** One voice clip in the mix: `wavPath(id)` names its file, and it is padded to `durationS`. */
interface MixSegment {
    id: string;
    durationS: number;
}
/** mix.wav: each segment's voice from its start, padded with silence to the segment's length, in order. */
declare function mixAudio(segments: readonly MixSegment[], wavPath: (id: string) => string, out: string): Promise<void>;
interface Encoder {
    write(png: Buffer): Promise<void>;
    finish(): Promise<void>;
}
/** One ffmpeg reading PNGs on stdin, muxing mix.wav, writing H.264 + AAC with no run-specific metadata. */
declare function startEncoder(out: string, fps: number, audio: string): Encoder;

export { type CapturePage, type Encoder, type FontState, type FramesOptions, type FramesResult, type MixSegment, type PageOptions, TITAN_MOTION_GLOBAL, type TitanMotionApi, VIRTUAL_TIME_SCRIPT, type Viewport, type VirtualTimeApi, captureFrame, captureFrames, launch, mixAudio, openCapturePage, settleFonts, startEncoder };
