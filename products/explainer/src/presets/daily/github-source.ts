import type { GhExec } from "@titan-design/github";
import { z } from "zod";
import type { DigestItem } from "../../digest.js";

const PrRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.url(),
  createdAt: z.iso.datetime({ offset: true }),
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
});
type PrRow = z.infer<typeof PrRowSchema>;

const PR_FIELDS = "number,title,url,createdAt,mergedAt";
// One day of one repo; a day over this is a cascade worth a note, not a silent cut.
export const PR_LIST_LIMIT = 200;

type PrChange = "opened" | "merged";

const SEARCH: Record<PrChange, { state: string; qualifier: string }> = {
  opened: { state: "all", qualifier: "created" },
  merged: { state: "merged", qualifier: "merged" },
};

export interface PrSourceResult {
  items: DigestItem[];
  notes: string[];
}

async function listPrs(gh: GhExec, repo: string, day: string, change: PrChange): Promise<PrRow[]> {
  const { state, qualifier } = SEARCH[change];
  const args = ["pr", "list", "--repo", repo, "--state", state, "--search", `${qualifier}:${day}`, "--json", PR_FIELDS, "--limit", String(PR_LIST_LIMIT)];
  const result = await gh(args);
  if (result.code !== 0) throw new Error(`gh pr list --repo ${repo} (${change}) failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return z.array(PrRowSchema).parse(JSON.parse(result.stdout));
}

const prItem = (repo: string, row: PrRow, change: PrChange): DigestItem => ({
  id: `pr/${repo}#${row.number}/${change}`,
  kind: "pull-request",
  title: row.title,
  at: change === "merged" && row.mergedAt ? row.mergedAt : row.createdAt,
  repo,
  url: row.url,
  change,
});

/** PRs opened and merged on `day` (UTC, as GitHub search reads a bare date) in each repo; a failed repo becomes a note. */
export async function pullRequestItems(gh: GhExec, repos: readonly string[], day: string): Promise<PrSourceResult> {
  const items: DigestItem[] = [];
  const notes: string[] = [];
  for (const repo of repos) {
    for (const change of ["opened", "merged"] as const) {
      try {
        const rows = await listPrs(gh, repo, day, change);
        if (rows.length >= PR_LIST_LIMIT) notes.push(`${repo}: ${change} PRs reached the ${PR_LIST_LIMIT} limit; the list may be cut`);
        items.push(...rows.map((row) => prItem(repo, row, change)));
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { items, notes };
}
