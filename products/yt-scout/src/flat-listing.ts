import type { VideoKind } from "./store.js";

export interface ListingEntry {
  id: string;
  title: string;
  channel?: string;
  duration?: number;
  kind: VideoKind;
}

const VIDEO_ID = /^[\w-]{11}$/;

const KIND_BY_LIVE_STATUS: Record<string, VideoKind> = { is_live: "live", is_upcoming: "upcoming", post_live: "post_live" };

/** Parse the `--dump-single-json` output of `yt-dlp --flat-playlist`; entries that are not video ids (tab playlists) are dropped. */
export function parseFlatListing(json: string): ListingEntry[] {
  const parsed: unknown = JSON.parse(json);
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((raw: Record<string, unknown>) => {
    if (typeof raw?.id !== "string" || !VIDEO_ID.test(raw.id)) return [];
    const liveStatus = typeof raw.live_status === "string" ? raw.live_status : "";
    return [
      {
        id: raw.id,
        title: typeof raw.title === "string" ? raw.title : "",
        channel: typeof raw.channel === "string" ? raw.channel : undefined,
        duration: typeof raw.duration === "number" ? Math.round(raw.duration) : undefined,
        kind: KIND_BY_LIVE_STATUS[liveStatus] ?? "vod",
      },
    ];
  });
}
