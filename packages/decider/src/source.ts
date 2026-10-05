import type { LedgerRowWire } from "./ledger.js";

/** Where a source stopped in one of its cursors: a byte offset bound to a hash of the bytes before it. */
export interface SourceWatermark {
  offset: number;
  prefixHash: string | null;
}

/** One source's watermarks, keyed by the source's own cursor name (a transcript path, an events table). */
export type SourceWatermarks = ReadonlyMap<string, SourceWatermark>;

/** A row the source found, before exclusion. `cwd` and `mentionedInitiatives` feed the exclusion check and are never stored. */
export interface SourceCandidate {
  row: LedgerRowWire;
  cwd: string | null;
  mentionedInitiatives?: readonly string[];
}

export interface SourceRead {
  candidates: SourceCandidate[];
  /** The cursors this read moved; cursors it did not touch keep their stored watermark. */
  watermarks: Map<string, SourceWatermark>;
  /** Questions seen without an answer yet; the watermark stops before them so the next read retries. */
  pending: number;
  errors: string[];
}

/** The port every ledger source implements. `read` returns only what lies past `since`. */
export interface LedgerSource {
  name: string;
  read(since: SourceWatermarks): Promise<SourceRead>;
}
