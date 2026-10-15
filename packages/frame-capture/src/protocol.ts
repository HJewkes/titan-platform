/**
 * The only contract between a capture and the page it captures. The page publishes this object as
 * `window.__titanMotion`; the capture never imports the page's code. The shape matches titan-design's
 * `TitanMotionApi` (react-ui `/motion`, `MotionProvider` on a `seekClock`), but any page that sets
 * the global can be captured.
 */
export interface TitanMotionApi {
  /** Shows the frame at `t` seconds. It must commit synchronously: the capture screenshots after `ready()`. */
  seek(t: number): void
  /** Resolves once the frame `seek` committed has nothing left to load (fonts, images, pending data). */
  ready(): Promise<void>
  /** The timeline length in seconds; the capture renders `duration * fps` frames unless told otherwise. */
  readonly duration: number
}

/** The global the page publishes `TitanMotionApi` under. */
export const TITAN_MOTION_GLOBAL = '__titanMotion'
