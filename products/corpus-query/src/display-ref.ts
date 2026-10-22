import type { ChapterMeta } from "./types.js";

const SMALL_WORDS = new Set(["of", "the", "and", "in", "a", "to"]);

/** Series slug to the short prefix readers use: `some-long-series` becomes `SLS`, with small words kept lower-case. */
export function seriesPrefix(series: string): string {
  return series
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => (SMALL_WORDS.has(w.toLowerCase()) ? w[0]!.toLowerCase() : w[0]!.toUpperCase()))
    .join("");
}

/**
 * What a reader cites. Title codes restart per series, so a bare code is ambiguous; the series prefix disambiguates.
 * A ref that already opens with a letter (a code that carries its own prefix, or an id fallback) is left alone.
 */
export function displayRef(meta: Pick<ChapterMeta, "id" | "ref" | "series">): string {
  if (!/^\d/.test(meta.ref) || meta.series === "other" || meta.series === "") return meta.ref;
  return `${seriesPrefix(meta.series)} ${meta.ref}`;
}
