import { z } from "zod";
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

const RawEntry = z.object({
  id: z.string().regex(VIDEO_ID),
  title: z.string().catch(""),
  channel: z.string().optional().catch(undefined),
  duration: z.number().optional().catch(undefined),
  live_status: z.string().optional().catch(undefined),
});
const Listing = z.object({ entries: z.array(z.unknown()).catch([]) });

/** Parse the `--dump-single-json` output of `yt-dlp --flat-playlist`; entries that are not video ids (tab playlists) are dropped. */
export function parseFlatListing(json: string): ListingEntry[] {
  const { entries } = Listing.parse(JSON.parse(json));
  return entries.flatMap((raw) => {
    const e = RawEntry.safeParse(raw);
    if (!e.success) return [];
    const { live_status, duration, ...rest } = e.data;
    return [{ ...rest, duration: duration === undefined ? undefined : Math.round(duration), kind: KIND_BY_LIVE_STATUS[live_status ?? ""] ?? "vod" }];
  });
}
