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
 * the page reads real time: Date, performance.now, timers, rAF, document.timeline and running animations
 * all follow a clock that only `__virtualTime.advanceTo(ms)` moves, and Math.random is seeded.
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
    /** Fires every timer due by `ms` in order, sets the clock to `ms`, runs one rAF frame, then syncs animations. */
    advanceTo(ms: number): void;
    /** Pauses every animation the page left running and sets it to the virtual time since it was first seen. */
    syncAnimations(): void;
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
/** The unloaded faces, and the font URLs the browser failed to fetch: the rejection itself says only "A network error occurred". */
declare class FontLoadError extends Error {
    readonly faces: readonly FontState[];
    readonly urls: readonly string[];
    constructor(faces: readonly FontState[], urls: readonly string[]);
}
declare function launch(): Promise<Browser>;
/**
 * Runs `use` in `lent` when the caller lends a browser, and leaves it open for the caller's next use; otherwise
 * in a browser launched here and closed after. A lent browser keeps whatever `use` leaves open, so `use` closes
 * its own contexts.
 */
declare function withBrowser<T>(lent: Browser | undefined, use: (browser: Browser) => Promise<T>): Promise<T>;
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
 * The page in a context of its own. A failed open closes that context, so a browser lent across opens is not left
 * holding the pages of the ones that failed.
 */
declare function openCapturePage(browser: Browser, url: string, options: PageOptions): Promise<CapturePage>;
/** Opens a capture page, runs `use` on it and closes its context however `use` ends. */
declare function withCapturePage<T>(browser: Browser, url: string, options: PageOptions, use: (opened: CapturePage) => Promise<T>): Promise<T>;
/** One frame: advance virtual time, seek (commits through flushSync), await ready(), sync the animations the seek started, screenshot. */
declare function captureFrame(page: Page, t: number): Promise<Buffer>;
/**
 * The viewport as a PNG with the caret hidden. `optimizeForSpeed` swaps Chromium's PNG encoder for a faster zlib
 * setting: the pixels are the same and the bytes are the same run to run, but the files are about 2.5x larger. At
 * 1920x1080 it cut a shot from about 42 to 25 ms, which is most of a capture's time.
 */
declare function screenshotFrame(page: Page): Promise<Buffer>;

type Sink = (index: number, png: Buffer) => Promise<void>;

interface FramesOptions extends PageOptions {
    url: string;
    fps: number;
    /** Frame count; defaults to the page's duration times fps. */
    frames?: number;
    /**
     * Pages capturing contiguous chunks in parallel. A fixed count renders byte-identically run to run.
     * Without `beatStartsS`, a chunk can start mid-beat, and its first frames can then differ from a
     * sequential render by a few levels of anti-aliasing.
     */
    workers?: number;
    /**
     * Where frames that cannot reach the sink yet wait; required with `workers` above 1. It needs room for most of the
     * video's PNGs, so it must be real disk: a tmpfs such as many a /tmp would hold them in RAM. The capture makes its
     * own directory inside this one and removes it however the capture ends.
     */
    spillDir?: string;
    /**
     * Seconds at which the page lays out a fresh scene. Chunks then start only on these frames, so any
     * worker count renders the same frames as one worker; fewer chunks than `workers` run when there are
     * fewer beats.
     */
    beatStartsS?: readonly number[];
    /** A browser to capture in, left open; without one the capture launches its own and closes them. */
    browser?: Browser;
}
interface FramesResult {
    frames: number;
    /** `__titanMotion.duration`: the page's own idea of the timeline length. */
    pageDurationS: number;
    fonts: CapturePage['fonts'];
}
/**
 * One browser per chunk, not one page per chunk in a shared browser: screenshots encode in the browser
 * process, so a shared browser stops scaling at about 60 fps. The probe's browser goes on to capture the
 * first chunk, which saves a launch per capture and still runs one chunk per browser: the probe's page
 * closes before that chunk opens its own. A lent browser runs every chunk, for callers such as tests that
 * trade that scaling for one launch. A failure stops the other workers at their next frame, and the capture rejects
 * only once all of them have closed their browsers and the spill is gone.
 */
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

export { type CapturePage, type Encoder, FontLoadError, type FontState, type FramesOptions, type FramesResult, type MixSegment, type PageOptions, TITAN_MOTION_GLOBAL, type TitanMotionApi, VIRTUAL_TIME_SCRIPT, type Viewport, type VirtualTimeApi, captureFrame, captureFrames, launch, mixAudio, openCapturePage, screenshotFrame, settleFonts, startEncoder, withBrowser, withCapturePage };
