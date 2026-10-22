/**
 * Who hears about an owner's comment on a video, and the one notice they are sent. A comment about the
 * content goes to the seat that owns the work, named by the video's `owner` (its sidecar, or the folder
 * manifest); with no owner it goes to video-coord. A comment about the video itself, meaning how the
 * system made it, always goes to video-coord.
 *
 * The notice is fixed text built from the note's own fields and the notes file's path, sent through
 * the transport round notices use, so the comment's text is read from the notes file and never relayed.
 */
import type { SeatNotifier } from "./round-notice-transport.js";

const VIDEO_COORD = "video-coord";

export const NOTE_ABOUT = ["content", "video"] as const;
export type NoteAbout = (typeof NOTE_ABOUT)[number];

type RouteReason = "owner" | "unowned" | "about-video";

interface NoteRoute {
  seat: string;
  reason: RouteReason;
}

/** The seat a comment goes to; `owner` is the video's, absent when no sidecar or manifest names one. */
function noteRoute(about: NoteAbout, owner: string | undefined): NoteRoute {
  if (about === "video") return { seat: VIDEO_COORD, reason: "about-video" };
  return owner === undefined ? { seat: VIDEO_COORD, reason: "unowned" } : { seat: owner, reason: "owner" };
}

const WHY: Record<RouteReason, string> = {
  owner: "the video names you as its owner",
  unowned: "the video names no owner",
  "about-video": "it is about the video itself: how the system made it",
};

const ABOUT_LABELS: Record<NoteAbout, string> = { content: "the video's content", video: "the video itself" };

interface NoticeFacts {
  id: string;
  video: string;
  atS: number;
  about: NoteAbout;
}

const noteNotice = (note: NoticeFacts, reason: RouteReason, notesFile: string): string =>
  `titan-console: the owner commented on ${ABOUT_LABELS[note.about]} of ${note.video} at ${note.atS}s (${WHY[reason]}). ` +
  `The comment is note ${note.id} in ${notesFile} (titan-console/video-note@1); read it there.`;

/** Delivery is best effort: the notes file is the store of record, so a failed send loses nothing but the nudge. */
export async function deliverNote(notify: SeatNotifier | undefined, note: NoticeFacts, owner: string | undefined, notesFile: string): Promise<{ seat: string; delivered: boolean }> {
  const { seat, reason } = noteRoute(note.about, owner);
  if (notify === undefined) return { seat, delivered: false };
  try {
    await notify(seat, noteNotice(note, reason, notesFile));
    return { seat, delivered: true };
  } catch {
    return { seat, delivered: false };
  }
}
