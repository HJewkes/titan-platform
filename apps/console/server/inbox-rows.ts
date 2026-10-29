/**
 * What `inbox.list` sends the page, and the two upstream reads it keeps (TP-4390). An item carries fields the page never
 * renders and an asker may fill at any length, so a row leaves them out; planning rows open collapsed, so the default view
 * sends only their count and the page asks for them when the section opens. The factory's needs.list and Shepherd's
 * finished runs each take seconds, so the view serves a recent read of each while one refresh runs behind it.
 */
import type { OwnerItem } from "@titan-design/owner-queue";
import type { InboxItem, InboxSources, WatchRow } from "./inbox-view.js";
import type { FactoryNeeds } from "./approvals.js";
import { cachedRead, type CacheTimes, type CachedRead } from "./read-cache.js";

/** Long enough that a page and its taps share one needs read, short enough that a gate answered elsewhere leaves soon. */
const INBOX_CACHE_TIMES: CacheTimes = { freshMs: 15_000, staleMs: 5 * 60_000 };

type Recommendation = NonNullable<OwnerItem["recommended"]>;
type ShownRecommendation = Omit<Recommendation, "rationale" | "cite">;
type InboxRow = Omit<InboxItem, "context" | "anchors" | "pins" | "recommended"> & { recommended?: ShownRecommendation };

const shownRecommendation = ({ rationale: _rationale, cite: _cite, ...shown }: Recommendation): ShownRecommendation => shown;

export function inboxRow({ context: _context, anchors: _anchors, pins: _pins, recommended, ...row }: InboxItem): InboxRow {
  return recommended === undefined ? row : { ...row, recommended: shownRecommendation(recommended) };
}

export interface ViewRows {
  items: InboxRow[];
  /** Every planning item, whether or not `items` carries them. */
  planningCount: number;
}

export function viewRows(items: readonly InboxItem[], { planning = false }: { planning?: boolean }): ViewRows {
  const planningCount = items.filter((item) => item.section === "planning").length;
  const shown = planning ? items : items.filter((item) => item.section !== "planning");
  return { items: shown.map(inboxRow), planningCount };
}

export interface InboxReadCache {
  factory?: FactoryNeeds;
  finished: CachedRead<WatchRow[]>;
  /** `inbox.act` calls it after a write, so the page's next read shows the answered item gone. */
  invalidate(): void;
}

export function inboxReadCache({ factory, shepherd, now }: InboxSources, times: CacheTimes = INBOX_CACHE_TIMES): InboxReadCache {
  const needs = factory === undefined ? undefined : cachedRead(() => factory.list(), times, now);
  const finished = cachedRead(() => shepherd.list("finished"), times, now);
  return {
    ...(needs !== undefined && { factory: { list: () => needs.read() } }),
    finished,
    invalidate: () => {
      needs?.invalidate();
      finished.invalidate();
    },
  };
}
