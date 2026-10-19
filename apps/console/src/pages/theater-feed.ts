/**
 * The theater feed's logic, kept apart from its components so the grouping, the purpose cascade
 * and the URL state are tested without rendering: which purpose a render serves, which rows a
 * query shows, and how they fall into days in the reader's own timezone.
 */
import type { ConsoleCommands } from "../../server/commands.js";

export type VideoRow = ConsoleCommands["videos.list"]["result"]["videos"][number];
export type Purpose = NonNullable<VideoRow["purpose"]> | "other";

/** Chip order; `other` has no chip because a render with no known purpose is never filtered for. */
export const PURPOSES = ["daily", "repo-review", "plan", "design", "explainer", "test", "clip"] as const satisfies readonly Purpose[];

export const PURPOSE_LABELS: Record<Purpose, string> = {
  daily: "Daily",
  "repo-review": "Repo review",
  plan: "Plan",
  design: "Design",
  explainer: "Explainer",
  test: "Test",
  clip: "Clips",
  other: "Other",
};

/**
 * The dot is the only colour a purpose gets, and the label beside it always carries the meaning.
 * Hues are the dataviz categorical set (titan has no violet, so Plan takes green); clips and tests stay grey.
 * Whole class names, because Tailwind only emits classes it finds written out.
 */
export const PURPOSE_DOTS: Record<Purpose, string | null> = {
  daily: "bg-dataviz-categorical-6",
  "repo-review": "bg-dataviz-categorical-0",
  plan: "bg-dataviz-categorical-4",
  design: "bg-dataviz-categorical-1",
  explainer: "bg-dataviz-categorical-5",
  test: "bg-text-tertiary",
  clip: "bg-text-tertiary",
  other: null,
};

/** Anything shorter is a clip whatever else it says: too short to be watched as a video. */
const CLIP_MAX_S = 10;
const DAILY_SERIES = /^(daily-digest|day-recap)$/;
const REVIEW_SERIES = /^repo-review-/;

type PurposeInput = Pick<VideoRow, "purpose" | "tags" | "durationS" | "series" | "subject">;

/** The sidecar's `purpose` when an agent wrote one; otherwise a guess from tags, length, subject and series. */
export function purposeOf(video: PurposeInput): Purpose {
  if (video.purpose !== undefined) return video.purpose;
  const tagged = PURPOSES.find((purpose) => video.tags?.includes(purpose));
  if (tagged !== undefined) return tagged;
  if (video.durationS !== null && video.durationS < CLIP_MAX_S) return "clip";
  const series = video.series ?? "";
  if (video.subject?.kind === "repo" || REVIEW_SERIES.test(series)) return "repo-review";
  if (video.subject?.kind === "day" || DAILY_SERIES.test(series)) return "daily";
  return "other";
}

/** Everything the feed reads from `?q=`, `?tag=` and `?old=1`, so a filtered feed is a link. */
export interface FeedState {
  q: string;
  purpose: Purpose | null;
  old: boolean;
}

const isPurpose = (value: string | null): value is (typeof PURPOSES)[number] => PURPOSES.some((purpose) => purpose === value);

export function feedStateOf(query: string | undefined): FeedState {
  const params = new URLSearchParams(query ?? "");
  const tag = params.get("tag");
  return { q: params.get("q") ?? "", purpose: isPurpose(tag) ? tag : null, old: params.get("old") === "1" };
}

export function feedQuery(state: FeedState): string {
  const params = new URLSearchParams();
  if (state.purpose !== null) params.set("tag", state.purpose);
  if (state.q !== "") params.set("q", state.q);
  if (state.old) params.set("old", "1");
  return params.toString();
}

export interface FeedRow {
  video: VideoRow;
  purpose: Purpose;
}

function haystack({ video, purpose }: FeedRow): string {
  return [video.title, video.description, video.series, video.take, video.group, video.subject?.id, PURPOSE_LABELS[purpose], ...(video.tags ?? [])].join(" ").toLowerCase();
}

/** A search reaches every render; without one, superseded takes wait behind `?old=1`. */
export function searchedRows(videos: readonly VideoRow[], state: FeedState): FeedRow[] {
  const q = state.q.trim().toLowerCase();
  const rows = videos.map((video) => ({ video, purpose: purposeOf(video) }));
  return rows.filter((row) => (q !== "" ? haystack(row).includes(q) : state.old || !row.video.superseded));
}

/** The purpose chip narrows to its rows; with no chip and no search, clips wait behind their own chip. */
export function shownRows(searched: readonly FeedRow[], state: FeedState): FeedRow[] {
  if (state.purpose !== null) return searched.filter((row) => row.purpose === state.purpose);
  return state.q.trim() !== "" ? [...searched] : searched.filter((row) => row.purpose !== "clip");
}

export function purposeCounts(searched: readonly FeedRow[]): Record<Purpose, number> {
  const counts: Record<Purpose, number> = { daily: 0, "repo-review": 0, plan: 0, design: 0, explainer: 0, test: 0, clip: 0, other: 0 };
  for (const row of searched) counts[row.purpose] += 1;
  return counts;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `YYYY-MM-DD` of the instant in `timeZone`, the reader's own when unset; null for an unparseable time. */
export function dayKeyOf(iso: string, timeZone?: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Today, Yesterday, a weekday within the week, then the date; `date` is the subtitle beside the name. */
export function dayLabel(key: string, todayKey: string): { name: string; date: string } {
  const day = new Date(`${key}T00:00:00Z`);
  const ago = Math.round((Date.parse(`${todayKey}T00:00:00Z`) - day.getTime()) / DAY_MS);
  const dayMonth = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  const weekday = WEEKDAYS[day.getUTCDay()]!;
  if (ago === 0) return { name: "Today", date: `${weekday.slice(0, 3)} ${dayMonth}` };
  if (ago === 1) return { name: "Yesterday", date: `${weekday.slice(0, 3)} ${dayMonth}` };
  if (ago > 1 && ago < 7) return { name: weekday, date: dayMonth };
  return { name: dayMonth, date: `${weekday.slice(0, 3)} ${day.getUTCFullYear()}` };
}

export interface DaySection {
  key: string;
  name: string;
  date: string;
  rows: FeedRow[];
  totalS: number;
  /** Clips on this day the default feed hides, so the header can point at them. */
  hiddenClips: number;
}

interface Clock {
  now: Date;
  timeZone?: string;
}

/** Newest day first, newest render first within a day; a render with no readable time goes under "Undated". */
export function groupByDay(rows: readonly FeedRow[], hiddenClips: readonly FeedRow[], clock: Clock): DaySection[] {
  const keyOf = (row: FeedRow) => dayKeyOf(row.video.modifiedAt, clock.timeZone) ?? "";
  const byDay = new Map<string, FeedRow[]>();
  for (const row of [...rows].sort((a, b) => b.video.modifiedAt.localeCompare(a.video.modifiedAt))) byDay.set(keyOf(row), [...(byDay.get(keyOf(row)) ?? []), row]);
  for (const clip of hiddenClips) if (!byDay.has(keyOf(clip))) byDay.set(keyOf(clip), []);
  const todayKey = dayKeyOf(clock.now.toISOString(), clock.timeZone)!;
  return [...byDay.keys()]
    .sort()
    .reverse()
    .map((key) => ({
      key,
      ...(key === "" ? { name: "Undated", date: "" } : dayLabel(key, todayKey)),
      rows: byDay.get(key)!,
      totalS: byDay.get(key)!.reduce((sum, row) => sum + (row.video.durationS ?? 0), 0),
      hiddenClips: hiddenClips.filter((clip) => keyOf(clip) === key).length,
    }));
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatRunTime(seconds: number): string {
  const total = Math.round(seconds);
  const [hours, minutes, secs] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function sectionSubtitle(section: DaySection): string {
  const count = section.rows.length === 0 ? "" : section.rows.length === 1 ? "1 video" : `${section.rows.length} videos`;
  const total = count !== "" && section.totalS > 0 ? `, ${formatRunTime(section.totalS)}` : "";
  return [section.date, `${count}${total}`].filter((part) => part !== "").join(" · ");
}

/** The text cut into plain and matched runs, matching case-insensitively. */
export function splitMatches(text: string, q: string): { text: string; match: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
