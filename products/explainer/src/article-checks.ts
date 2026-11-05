import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { isShortQuote, wordCount } from "./presets/article/quotes.js";
import { QUOTE_MAX_WORDS, type ArticleFact, type FigureSeries } from "./presets/article/schemas.js";
import { PAPER_PUBLISH_CHECKS } from "./profile-checks.js";
import type { Beat, Storyboard } from "./storyboard.js";

export interface PublishIssue {
  check: string;
  beat?: string;
  message: string;
}

/**
 * Passing every check makes a video eligible to publish, nothing more. Publishing third-party text and figures always
 * waits for the owner to ask for that one video (owner Q4 B); no code path publishes on eligibility alone.
 */
export interface PublishEligibility {
  eligible: boolean;
  ownerAskRequired: true;
  issues: PublishIssue[];
}

interface CheckContext {
  board: Storyboard;
  facts: readonly ArticleFact[];
  quoteMaxWords: number;
}

type PublishCheck = (context: CheckContext) => PublishIssue[];

const IMAGE = /(\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif)([?#].*)?$)|^data:image\//i;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const samePoints = (a: FigureSeries["points"], b: FigureSeries["points"]) => a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);

interface ReplotSlots {
  source?: { ref?: unknown };
  series?: { points?: FigureSeries["points"] }[];
}

function replotIssue(beat: Beat, figures: ReadonlyMap<string, ArticleFact>): string | undefined {
  const slots = beat.slots as ReplotSlots;
  const fact = typeof slots.source?.ref === "string" ? figures.get(slots.source.ref) : undefined;
  if (!fact) return `replot ${beat.id} cites no gathered figure; its source.ref must name a figure fact id`;
  const series = Array.isArray(slots.series) ? slots.series : [];
  const plotted = series.every((line) => Array.isArray(line.points) && fact.figure!.series.some((data) => samePoints(line.points!, data.points)));
  return series.length > 0 && plotted ? undefined : `replot ${beat.id} plots points that are not ${fact.id}'s data`;
}

function figureIssue(beat: Beat, figures: ReadonlyMap<string, ArticleFact>): string | undefined {
  if (strings(beat.slots).some((value) => IMAGE.test(value.trim()))) return `${beat.id} shows an image; a figure is re-plotted from data, never a picture of it`;
  if (beat.type === "replot") return replotIssue(beat, figures);
  const cited = beat.sources.find((source) => figures.has(source));
  return cited ? `${beat.id} shows ${cited} as a ${beat.type} beat; a figure is shown only as a replot of its data` : undefined;
}

const figuresReplotted: PublishCheck = ({ board, facts }) => {
  const figures = new Map(facts.filter((fact) => fact.kind === "figure" && fact.figure).map((fact) => [fact.id, fact]));
  return board.beats.flatMap((beat) => {
    const message = figureIssue(beat, figures);
    return message ? [{ check: "figures-replotted-from-data", beat: beat.id, message }] : [];
  });
};

function slotQuotes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(slotQuotes);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    if (key !== "quote") return slotQuotes(inner);
    return typeof inner === "string" ? [inner] : isRecord(inner) ? strings(inner.text) : [];
  });
}

const QUOTED = /“([^”]*)”|"([^"]*)"/g;

const spokenQuotes = (text: string | undefined) => [...(text ?? "").matchAll(QUOTED)].map((match) => match[1] ?? match[2] ?? "");

const quotesShort: PublishCheck = ({ board, quoteMaxWords }) =>
  board.beats.flatMap((beat) =>
    [...slotQuotes(beat.slots), ...spokenQuotes(beat.spoken), ...spokenQuotes(beat.display)]
      .filter((quote) => !isShortQuote(quote, quoteMaxWords))
      .map((quote) => ({ check: "quotes-short", beat: beat.id, message: `${beat.id} quotes ${wordCount(quote)} words; the limit is ${quoteMaxWords}` })),
  );

export const ARTICLE_PUBLISH_CHECKS: Record<(typeof PAPER_PUBLISH_CHECKS)[number], PublishCheck> = {
  "figures-replotted-from-data": figuresReplotted,
  "quotes-short": quotesShort,
};

const isKnownCheck = (check: string): check is keyof typeof ARTICLE_PUBLISH_CHECKS => Object.hasOwn(ARTICLE_PUBLISH_CHECKS, check);

/**
 * Runs the profile's `publish.checks` over a paper video's storyboard against its gathered facts. A check this
 * module does not know fails the video rather than being skipped, so a new profile check never reads as passed.
 */
export function paperPublishEligibility(
  board: Storyboard,
  facts: readonly ArticleFact[],
  checks: readonly string[] = PAPER_PUBLISH_CHECKS,
  quoteMaxWords = QUOTE_MAX_WORDS,
): PublishEligibility {
  const context = { board, facts, quoteMaxWords };
  const issues = checks.flatMap((check) =>
    isKnownCheck(check) ? ARTICLE_PUBLISH_CHECKS[check](context) : [{ check, message: `publish check ${check} is not implemented; the video is not eligible` }],
  );
  if (checks.length === 0) issues.push({ check: "none", message: "the profile names no publish checks; nothing makes the video eligible" });
  return { eligible: issues.length === 0, ownerAskRequired: true, issues };
}
