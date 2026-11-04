import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import type { BlobStore } from "./blob-store.js";

/** Placeholder pending the owner's retention decision (TP-3105 plan O5); callers may pass their own window. */
export const DEFAULT_RETAIN_LANDED_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOB_FILE_NAME = /^[0-9a-f]{64}$/;

interface CollectOptions {
  /** Items the caller counts as open; there is no work-item table here, so the caller decides (plan O2). */
  openItems: ReadonlySet<string>;
  retainLandedDays?: number;
  now: Date;
}

interface CollectResult {
  kept: number;
  deleted: number;
  filesDeleted: number;
}

/**
 * A marker is rooted when its item is open, when its item landed inside the retention window, or when a
 * factory_marker_root row names it. Superseded rows of a rooted item are rooted too: they are the item's history.
 * A NULL in a NOT IN list makes the test NULL for every row, so a malformed read must not reach the list.
 */
const ROOTED_DIGESTS = `
  WITH rooted AS (
    SELECT reads, output_digest FROM factory_marker
    WHERE item IN (SELECT value FROM json_each(@openItems))
       OR item IN (
         SELECT item FROM factory_marker WHERE fact = 'landed' AND pin_class = 'landed'
         GROUP BY item HAVING MAX(written_at) > @cutoff)
       OR id IN (SELECT marker_id FROM factory_marker_root)
  )
  SELECT output_digest AS digest FROM rooted WHERE output_digest IS NOT NULL
  UNION
  SELECT json_extract(r.value, '$.digest') AS digest FROM rooted, json_each(rooted.reads) AS r
  WHERE json_extract(r.value, '$.digest') IS NOT NULL`;

/**
 * Deletes every blob no rooted marker references, then sweeps files that have no blob row. Marker rows are never
 * deleted. Rows go inside one transaction and files only after it commits, so a crash leaves an extra file but
 * never a row without its file.
 */
export function collectMarkerBlobs(db: Db, blobs: BlobStore, options: CollectOptions): CollectResult {
  const days = options.retainLandedDays ?? DEFAULT_RETAIN_LANDED_DAYS;
  const params = {
    openItems: JSON.stringify([...options.openItems]),
    cutoff: new Date(options.now.getTime() - days * DAY_MS).toISOString(),
  };
  const { kept, deleted } = db
    .transaction(() => {
      const deleted = db.prepare(`DELETE FROM factory_marker_blob WHERE digest NOT IN (${ROOTED_DIGESTS})`).run(params).changes;
      const kept = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM factory_marker_blob").get()?.n ?? 0;
      return { kept, deleted };
    })
    .immediate();
  return { kept, deleted, filesDeleted: sweepFiles(db, blobs.blobDir) };
}

/** Only digest-named files are swept: a `.tmp` file may be a write still in flight, which an unlink would break. */
function sweepFiles(db: Db, blobDir: string): number {
  const live = new Set(
    db.prepare<[], { path: string }>("SELECT path FROM factory_marker_blob WHERE path IS NOT NULL").all().map((row) => row.path),
  );
  const orphans = listFiles(blobDir).filter((name) => BLOB_FILE_NAME.test(name) && !live.has(name));
  for (const name of orphans) unlinkSync(join(blobDir, name));
  return orphans.length;
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
