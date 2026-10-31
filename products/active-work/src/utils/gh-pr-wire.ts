import { z } from 'zod';

/**
 * One element of `gh pr list --json headRefName,number,state,title,url,statusCheckRollup`.
 *
 * Every field is nullish: callers still decide what a missing field means, and a
 * pending check run reports a null conclusion. Unknown keys survive the parse.
 */
export const GhPrListEntrySchema = z.looseObject({
  headRefName: z.string().nullish(),
  number: z.number().nullish(),
  state: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  statusCheckRollup: z
    .array(z.looseObject({ conclusion: z.string().nullish(), state: z.string().nullish() }))
    .nullish(),
});

export type GhPrListEntry = z.infer<typeof GhPrListEntrySchema>;

export interface GhPrList {
  entries: GhPrListEntry[];
  /** Elements that were not a PR entry; they are left out of `entries`. */
  skipped: number;
  /** Length of the array gh returned, skipped elements included. */
  total: number;
}

/** Parse gh's stdout; null when it is not a JSON array. Throws on invalid JSON. */
export function parseGhPrList(stdout: string): GhPrList | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return null;
  const entries: GhPrListEntry[] = [];
  for (const element of parsed) {
    const entry = GhPrListEntrySchema.safeParse(element);
    if (entry.success) entries.push(entry.data);
  }
  return { entries, skipped: parsed.length - entries.length, total: parsed.length };
}
