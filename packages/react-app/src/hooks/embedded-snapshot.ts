import {
  liveSource,
  parseSnapshot,
  staticSource,
  type DataSource,
  type Snapshot,
  type SnapshotResolver,
} from "@titan-design/rpc-client";

/** The element an exported page carries its snapshot in. */
export const SNAPSHOT_ELEMENT_ID = "titan-snapshot";

/**
 * Writes a snapshot into a built page so it opens from disk with no server. Replaces any
 * snapshot already there. Pure string work, so an exporter can run it in Node.
 */
export function embedSnapshot(html: string, snapshot: Snapshot): string {
  // Escaping "<" keeps "</script>" or "<!--" inside a string value from ending the element early.
  const json = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const element = `<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">${json}</script>\n`;
  const embedded = new RegExp(`<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">[\\s\\S]*?</script>\\s*`, "g");
  const page = html.replace(embedded, "");
  const at = page.search(/<\/head>/i);
  return at === -1 ? `${element}${page}` : `${page.slice(0, at)}${element}${page.slice(at)}`;
}

/** The snapshot an exported page carries, or `undefined` for a page a daemon serves. */
export function readEmbeddedSnapshot(doc: Document = document): Snapshot | undefined {
  const text = doc.getElementById(SNAPSHOT_ELEMENT_ID)?.textContent;
  return text ? parseSnapshot(JSON.parse(text)) : undefined;
}

export interface PageSourceOptions {
  doc?: Document;
  /** Daemon origin for the live case; empty means the page's own origin. */
  origin?: string;
  /** Answers static calls the snapshot did not record. */
  resolve?: SnapshotResolver;
}

/** A static source over the embedded snapshot when the page has one, otherwise a live one. */
export function pageDataSource(options: PageSourceOptions = {}): DataSource {
  const snapshot = readEmbeddedSnapshot(options.doc);
  if (snapshot) return staticSource({ snapshot, resolve: options.resolve });
  return liveSource({ origin: options.origin });
}
