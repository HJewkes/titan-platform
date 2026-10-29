import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@titan-design/store-sqlite";
import { AtomParseError, parseAtom } from "./atom.js";
import type { Source, Watchlist } from "./config.js";
import { dispositionOf } from "./filter.js";
import { parseFlatListing, type ListingEntry } from "./flat-listing.js";
import type { StepRow } from "./rows.js";
import type { DetectedVideo, Detector } from "./seams.js";

const PLAYLIST_END = "30";

export interface DetectDeps {
  fetchText(url: string): Promise<{ status: number; text: string }>;
  ytDlp(args: string[]): Promise<string>;
  onRow(row: StepRow): void;
}

const run = promisify(execFile);

export function realDeps(onRow: (row: StepRow) => void, ytDlpBin = "yt-dlp"): DetectDeps {
  return {
    async fetchText(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: res.status, text: await res.text() };
    },
    async ytDlp(args) {
      return (await run(ytDlpBin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })).stdout;
    },
    onRow,
  };
}

/** The configured binary, else `YT_DLP`, else `yt-dlp` on PATH. */
export function resolveYtDlp(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return configured || env.YT_DLP || "yt-dlp";
}

const listingArgs = (url: string): string[] => ["--flat-playlist", "--playlist-end", PLAYLIST_END, "--dump-single-json", url];

// Current yt-dlp has no ytsearchdate: prefix; sp=CAI%3D asks YouTube's results page for newest first.
const searchUrl = (query: string): string => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAI%3D`;

function tabUrls(source: Source, tabs: readonly string[]): string[] {
  const base = source.handle ? `https://www.youtube.com/@${source.handle}` : `https://www.youtube.com/channel/${source.channel_id}`;
  return tabs.map((tab) => `${base}/${tab}`);
}

const matches = (source: Source, e: ListingEntry): boolean => {
  const re = new RegExp(source.match!, "i");
  return re.test(e.title) || re.test(e.channel ?? "");
};

function rssErrorClass(status: number): string {
  if (status === 404) return "rss_404";
  return status >= 500 ? "rss_5xx" : "rss_error";
}

/** Atom first; null with the failure's error class when the feed is unusable. */
async function tryRss(deps: DetectDeps, source: Source): Promise<{ videos: DetectedVideo[] } | { errorClass: string }> {
  try {
    const res = await deps.fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${source.channel_id}`);
    if (res.status !== 200) return { errorClass: rssErrorClass(res.status) };
    return { videos: parseAtom(res.text).map((e) => ({ id: e.id, source: source.key, kind: e.kind, title: e.title, published: e.published })) };
  } catch (err) {
    return { errorClass: err instanceof AtomParseError ? "rss_parse" : "rss_error" };
  }
}

const fromListing = (source: Source, e: ListingEntry): DetectedVideo => ({
  id: e.id,
  source: source.key,
  kind: e.kind,
  title: e.title,
  duration: e.duration,
});

async function listFlat(deps: DetectDeps, source: Source, urls: string[]): Promise<DetectedVideo[]> {
  const found: DetectedVideo[] = [];
  for (const url of urls) {
    for (const entry of parseFlatListing(await deps.ytDlp(listingArgs(url)))) found.push(fromListing(source, entry));
  }
  return found;
}

function dedupe(videos: DetectedVideo[]): DetectedVideo[] {
  return [...new Map(videos.map((v) => [v.id, v])).values()];
}

export function createDetector(deps: DetectDeps, tabs: readonly string[]): Detector {
  return {
    async detect(source, now) {
      if (source.search !== undefined) {
        const entries = parseFlatListing(await deps.ytDlp(listingArgs(searchUrl(source.search))));
        return dedupe(entries.filter((e) => matches(source, e)).map((e) => fromListing(source, e)));
      }
      const started = Date.now();
      const rss = await tryRss(deps, source);
      if ("videos" in rss) return dedupe(rss.videos);
      deps.onRow({
        v: 1,
        video_id: null,
        source: source.key,
        step: "detect",
        attempt: 1,
        started_at: now.toISOString(),
        ms: Date.now() - started,
        outcome: "fallback",
        error_class: rss.errorClass,
      });
      return dedupe(await listFlat(deps, source, tabUrls(source, source.tabs ?? tabs)));
    },
  };
}

interface NewVideo extends DetectedVideo {
  state: string;
  next_retry_at: string | null;
}

/** Poll every source, drop ids already in `videos`, and attach each remaining id's filtered state. */
export async function detectNew(db: Db, watchlist: Watchlist, detector: Detector, now: Date): Promise<Map<string, NewVideo[]>> {
  const known = db.prepare<[string], { id: string }>("SELECT id FROM videos WHERE id = ?");
  const bySource = new Map<string, NewVideo[]>();
  const claimed = new Set<string>();
  for (const source of watchlist.sources) {
    const fresh: NewVideo[] = [];
    for (const video of await detector.detect(source, now)) {
      if (claimed.has(video.id) || known.get(video.id)) continue;
      claimed.add(video.id);
      fresh.push({ ...video, ...dispositionOf(video, watchlist.defaults, now) });
    }
    bySource.set(source.key, fresh);
  }
  return bySource;
}

export function insertNew(db: Db, found: Map<string, NewVideo[]>, now: Date): number {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO videos (id, source, kind, title, detected_at, published, duration, state, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const v of [...found.values()].flat()) {
    n += Number(insert.run(v.id, v.source, v.kind, v.title ?? null, now.toISOString(), v.published ?? null, v.duration ?? null, v.state, v.next_retry_at).changes);
  }
  return n;
}

export function formatDetected(found: Map<string, NewVideo[]>): string[] {
  return [...found].flatMap(([key, videos]) => [
    `${key}: ${videos.length} new`,
    ...videos.map((v) => `  ${v.id} ${v.kind} ${v.state}${v.title ? ` ${v.title}` : ""}`),
  ]);
}
