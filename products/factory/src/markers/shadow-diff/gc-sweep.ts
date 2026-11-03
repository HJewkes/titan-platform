import type { Logger } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import { startSweep, type Sweep } from "../../sweep.js";
import type { BlobStore } from "../blob-store.js";
import { collectMarkerBlobs, DEFAULT_RETAIN_LANDED_DAYS } from "../gc.js";
import { itemKey } from "../pins.js";

export const MARKER_GC_MS = 24 * 60 * 60 * 1000;

interface RunItemRow {
  repo: unknown;
  pr: unknown;
}

const LIVE_RUN_ITEMS = `
  SELECT DISTINCT json_extract(params, '$.repo') AS repo, json_extract(params, '$.pr') AS pr
  FROM workflow_run WHERE status NOT IN ('completed', 'failed', 'cancelled')`;

const LANDED_ITEMS = "SELECT DISTINCT item FROM factory_marker WHERE fact = 'landed' AND pin_class = 'landed'";

/**
 * The items GC must keep: those a live run still works on, keyed as the shadow keys them. A landed item is closed even
 * while a run on it is still winding down, so its blobs age out on the landed retention window instead.
 */
export function openItemsOf(db: Db): Set<string> {
  const landed = new Set(db.prepare<[], { item: string }>(LANDED_ITEMS).all().map((row) => row.item));
  const open = new Set<string>();
  for (const row of db.prepare<[], RunItemRow>(LIVE_RUN_ITEMS).all()) {
    const key = keyOf(row);
    if (key !== undefined && !landed.has(key)) open.add(key);
  }
  return open;
}

/** The same rule as the shadow's `itemOf`: a run with no repo or no positive PR number has no item. */
function keyOf(row: RunItemRow): string | undefined {
  const pr = Number(row.pr);
  return typeof row.repo === "string" && row.repo !== "" && Number.isSafeInteger(pr) && pr > 0 ? itemKey({ repo: row.repo, pr }) : undefined;
}

/** Collects once at start, since serve restarts more often than daily, then once a day. */
export function startMarkerGcSweep(db: Db, blobs: BlobStore, log: Logger, now: () => number = Date.now): Sweep {
  const tickOnce = async (): Promise<void> => {
    const result = collectMarkerBlobs(db, blobs, { openItems: openItemsOf(db), retainLandedDays: DEFAULT_RETAIN_LANDED_DAYS, now: new Date(now()) });
    log.info({ ...result }, "marker GC swept");
  };
  const sweep = startSweep(tickOnce, MARKER_GC_MS, "marker GC sweep", log);
  void sweep.tick();
  return sweep;
}
