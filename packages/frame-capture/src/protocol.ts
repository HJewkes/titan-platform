/**
 * The only contract between a capture and the page it captures. The page publishes this object as
 * `window.__titanMotion`; the capture never imports the page's code. The shape matches titan-design's
 * `TitanMotionApi` (react-ui `/motion`, `MotionProvider` on a `seekClock`), but any page that sets
 * the global can be captured.
 */
export const MARK_KINDS = ['settled', 'step', 'before', 'transform-start', 'transform-end', 'hero'] as const

export type MarkKind = (typeof MARK_KINDS)[number]

/** A moment worth looking at: `t` seconds into beat number `beat`. */
export interface PageMark {
  t: number
  beat: number
  kind: MarkKind
}

export interface TitanMotionApi {
  /** Shows the frame at `t` seconds. It must commit synchronously: the capture screenshots after `ready()`. */
  seek(t: number): void
  /** Resolves once the frame `seek` committed has nothing left to load (fonts, images, pending data). */
  ready(): Promise<void>
  /** The timeline length in seconds; the capture renders `duration * fps` frames unless told otherwise. */
  readonly duration: number
  /** The moments the page marks, read once after the API appears; a page without it has no marks. */
  marks?(): PageMark[]
}

/** The global the page publishes `TitanMotionApi` under. */
export const TITAN_MOTION_GLOBAL = '__titanMotion'
