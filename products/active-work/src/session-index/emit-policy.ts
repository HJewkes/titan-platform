/**
 * What active-work asks session-graph to store on every indexing path. Pinned to
 * the pre-TP-880 classes until TP-881 drops them together with TRANSCRIPT_FIELDS;
 * the full and delta passes share it so neither can drift to the package's
 * default-off policy alone.
 */
export const EMIT_POLICY = { indexToolSpans: true, contextBlocks: true } as const;
