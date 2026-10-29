import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readOnlyUri } from "../corpus/factory-db.js";

export interface MergedPr {
  /** The allowlist's spelling of the repo, so later stages key on one form whatever case the graph stored. */
  repo: string;
  number: number;
  mergedAt: string;
  closedAt: string | null;
}

interface MergedPrsQuery {
  /** `owner/name` allowlist, matched case-insensitively. */
  repos: readonly string[];
  /** ISO instant; a PR merged at exactly this instant is included. */
  until: string;
}

export interface GraphReader {
  mergedPrs(query: MergedPrsQuery): MergedPr[];
  close(): void;
}

const PrRow = z.object({ repo: z.string(), number: z.number().int(), mergedAt: z.string(), closedAt: z.string().nullable() });

// julianday compares instants, not strings, so `...Z` and `....000Z` spellings of one time agree;
// an unmerged row's null merged_at makes the comparison null, which drops it.
const MERGED_PRS_SQL = `
  select repo, number, merged_at as mergedAt, closed_at as closedAt from pr
  where julianday(merged_at) <= julianday(@until)
    and lower(repo) in (select lower(value) from json_each(@repos))`;

export function canonicalUntil(until: string): string {
  const time = Date.parse(until);
  if (Number.isNaN(time)) throw new Error(`until is not an ISO time: ${until}`);
  return new Date(time).toISOString();
}

function byRepoThenNumber(a: MergedPr, b: MergedPr): number {
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  return a.number - b.number;
}

export function openGraph(path: string): GraphReader {
  const db = new DatabaseSync(readOnlyUri(path));
  return {
    mergedPrs: ({ repos, until }) => {
      const spelling = new Map(repos.map((repo) => [repo.toLowerCase(), repo]));
      const rows = db.prepare(MERGED_PRS_SQL).all({ until: canonicalUntil(until), repos: JSON.stringify(repos) });
      return rows
        .map((row) => PrRow.parse(row))
        .map((row) => ({ ...row, repo: spelling.get(row.repo.toLowerCase()) ?? row.repo }))
        .sort(byRepoThenNumber);
    },
    close: () => db.close(),
  };
}
