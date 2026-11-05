import type { ScriptV1 } from "./script-schema.js";

/**
 * The theater's sidecar, `<stem>.video.json` beside the video: the console's `titan-console/video-meta@1` (its schema is
 * `apps/console/server/video-meta.ts`, a strict object, so a key it does not list makes the sidecar unreadable).
 */
export const VIDEO_META_SCHEMA = "titan-console/video-meta@1";
/** 30 % in is past the title card and the hook, so the poster shows the video's own picture. */
export const POSTER_FRACTION = 0.3;
export const POSTER_WIDTH = 480;
export const SIDECAR_STATUSES = ["draft", "review", "final", "superseded"] as const;
export type SidecarStatus = (typeof SIDECAR_STATUSES)[number];

/** Which run made the video; the console carries it through and never renders it. */
export interface ExplainerBlock {
  videoId: string;
  runIds: string[];
  profile: string;
  scriptSha: string;
  fingerprint: Record<string, unknown>;
}

export interface VideoSidecar {
  schema: typeof VIDEO_META_SCHEMA;
  title: string;
  description?: string;
  purpose: "daily" | "repo-review" | "design" | "explainer";
  series: string;
  subject?: { kind: "repo" | "day"; id: string };
  take: string;
  status: SidecarStatus;
  posterAtS: number;
  poster: string;
  explainer: ExplainerBlock;
}

type Classified = Pick<VideoSidecar, "title" | "purpose" | "series" | "subject">;

const REPO_PROFILES = new Set(["repo-tour", "repo-argument", "repo-review"]);
const DAILY_PROFILES = new Set(["daily-overview"]);
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;
const REVIEW_SUFFIX = /-review(?:-explainers?)?$/;

const round1 = (value: number): number => Math.round(value * 10) / 10;

export const posterAt = (durationS: number): number => round1(durationS * POSTER_FRACTION);

/**
 * Purpose, series, subject and title from the profile, then the script id: the cascade `write_video_meta.py` ran, with
 * the profile id read first. The title is the script id less its date, since no run artifact carries a written one.
 */
export function classify(script: Pick<ScriptV1, "id" | "profile">, profile: string): Classified {
  const date = DATE_SUFFIX.exec(script.id)?.[1];
  const series = script.id.replace(DATE_SUFFIX, "");
  const words = series.replaceAll("-", " ");
  if (REPO_PROFILES.has(profile) || script.id.includes("-review-")) {
    const repo = series.replace(REVIEW_SUFFIX, "") || series;
    return { title: `${repo} review explainer`, purpose: "repo-review", series: "repo-review-explainers", subject: { kind: "repo", id: repo } };
  }
  if (DAILY_PROFILES.has(profile) || (profile === "status" && date)) {
    return { title: date ? `${words} ${date}` : words, purpose: "daily", series, ...(date ? { subject: { kind: "day", id: date } } : {}) };
  }
  return { title: words, purpose: profile.includes("design") ? "design" : "explainer", series };
}

export interface SidecarInput {
  script: Pick<ScriptV1, "id" | "profile" | "video">;
  /** The run's profile id; the script's own `profile` when the run names none. */
  profile: string;
  durationS: number;
  /** The theater stem: the poster sits beside the video as `<stem>-poster.jpg`. */
  stem: string;
  take: string;
  status: SidecarStatus;
  explainer: ExplainerBlock;
}

/** The port of `write_video_meta.py`'s `build_meta`: v1 fields only, plus the `explainer` block. */
export function buildSidecar(input: SidecarInput): VideoSidecar {
  const { title, ...rest } = classify(input.script, input.profile);
  const promise = input.script.video.promise;
  return {
    schema: VIDEO_META_SCHEMA, title, ...(promise ? { description: promise } : {}), ...rest,
    take: input.take, status: input.status, posterAtS: posterAt(input.durationS), poster: `${input.stem}-poster.jpg`, explainer: input.explainer,
  };
}
