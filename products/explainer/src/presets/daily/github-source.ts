import type { GhExec } from "@titan-design/github";
import { z } from "zod";
import type { DigestItem } from "../../digest.js";

const PrRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.url(),
  createdAt: z.iso.datetime({ offset: true }),
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
  headRefName: z.string().optional(),
  body: z.string().nullish(),
  files: z.array(z.object({ path: z.string() })).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
type PrRow = z.infer<typeof PrRowSchema>;

const PR_FIELDS = "number,title,url,createdAt,mergedAt,headRefName,body,files,additions,deletions";
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

const OUTCOME_LIMIT = 200;
const PROSE_LINE = /^[A-Za-z0-9`"'(]/;

/** The first sentence of the body's first prose line (not a heading, list item, table or comment), else the title. */
export function prOutcome(body: string | null | undefined, title: string): string {
  const prose = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n").map((line) => line.trim()).find((line) => PROSE_LINE.test(line));
  const sentence = prose?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? prose;
  return sentence && sentence.length <= OUTCOME_LIMIT ? sentence : title;
}

/** `packages/a/src/x.ts` is package `packages/a`; a changeset is release paperwork, not a package. */
export function prPackages(files: readonly { path: string }[]): string[] {
  const paths = files.map((file) => file.path).filter((path) => !path.startsWith(".changeset/"));
  return [...new Set(paths.map((path) => path.split("/").slice(0, 2).join("/")))].sort();
}

const mergedDetail = (row: PrRow): Partial<DigestItem> => ({
  ...(row.headRefName ? { branch: row.headRefName } : {}),
  outcome: prOutcome(row.body, row.title),
  packages: prPackages(row.files ?? []),
  size: (row.additions ?? 0) + (row.deletions ?? 0),
  priority: "P1",
});

const prItem = (repo: string, row: PrRow, change: PrChange): DigestItem => ({
  id: `pr/${repo}#${row.number}/${change}`,
  kind: "pull-request",
  title: row.title,
  at: change === "merged" && row.mergedAt ? row.mergedAt : row.createdAt,
  repo,
  url: row.url,
  change,
  ...(change === "merged" ? mergedDetail(row) : {}),
});

// A PR opened and merged the same day is one event; its merged row carries it.
function withoutMergedOpens(items: DigestItem[]): DigestItem[] {
  const merged = new Set(items.filter((item) => item.change === "merged").map((item) => item.id.replace(/\/merged$/, "")));
  return items.filter((item) => item.change !== "opened" || !merged.has(item.id.replace(/\/opened$/, "")));
}

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
  return { items: withoutMergedOpens(items), notes };
}
