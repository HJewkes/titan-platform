/**
 * Where a Ship round's proven head stands now: merged or not, the PR base's tip, and how many base commits the
 * proven head lacks. Read from GitHub through the port, never by fetching, and cached per binding, so a page
 * that re-renders or re-reads `rounds.get` costs at most one read a minute.
 */
import { z } from "zod";
import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);

export const shipLineage = z.discriminatedUnion("known", [
  z.strictObject({
    known: z.literal(true),
    /** The head the round's verdict and CI proved: the merge binding's `headSha`. */
    provenSha: sha40,
    /** GitHub's PR state; a closed PR that did not merge was never compared, so its `behind` is null. */
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    mergeSha: sha40.nullable(),
    /** The PR's head now; another sha than `provenSha` means it moved after the proof. */
    headSha: sha40,
    baseRef: z.string().min(1),
    baseSha: sha40,
    /** Base commits the proven head lacks; null unless the PR is open and still at the proven head, the only case GitHub compares. */
    behind: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({ known: z.literal(false), reason: z.string() }),
]);

export type ShipLineage = z.infer<typeof shipLineage>;
interface MergeBinding {
  repo: string;
  pr: number;
  headSha: string;
}
export type LineageReader = (binding: MergeBinding) => Promise<ShipLineage>;

type LineagePort = Pick<GitHubPort, "getPr" | "getHeadSha">;

interface LineageOptions {
  github?: LineagePort;
  ttlMs?: number;
  now?: () => number;
}

const LINEAGE_TTL_MS = 60_000;

export const UNWIRED_LINEAGE: ShipLineage = { known: false, reason: "no GitHub reader is wired" };

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every failure is an unknown lineage with its reason, so the Ship view never shows a blank or a guess. */
export async function readLineage(github: LineagePort, { repo, pr, headSha }: MergeBinding): Promise<ShipLineage> {
  try {
    const read = await github.getPr(repo, pr);
    const baseSha = await github.getHeadSha(repo, read.baseRef);
    if (baseSha === null) return { known: false, reason: `${read.baseRef} has no tip on ${repo}` };
    // `getPr` fills `behindBy` with 0 for a PR that is not open, so only an open one at the proven head was compared.
    const comparedProven = read.state === "open" && read.headSha === headSha && read.behindBy !== undefined;
    const lineage = {
      known: true, provenSha: headSha, state: read.state, merged: read.merged, mergeSha: read.merged ? read.mergeSha : null,
      headSha: read.headSha, baseRef: read.baseRef, baseSha, behind: comparedProven ? (read.behindBy ?? null) : null,
    };
    const parsed = shipLineage.safeParse(lineage);
    return parsed.success ? parsed.data : { known: false, reason: `GitHub answered an unexpected shape for ${repo}#${pr}` };
  } catch (error) {
    return { known: false, reason: `${repo}#${pr} unread: ${reasonOf(error)}` };
  }
}

export function shipLineageReader(options: LineageOptions = {}): LineageReader {
  const github = options.github ?? githubPort(ghCliWire());
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; read: Promise<ShipLineage> }>();
  return (binding) => {
    const key = `${binding.repo}#${binding.pr}@${binding.headSha}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (options.ttlMs ?? LINEAGE_TTL_MS)) return hit.read;
    const read = readLineage(github, binding);
    cache.set(key, { at: now(), read });
    return read;
  };
}
