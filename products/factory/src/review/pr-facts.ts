import type { GitHubPort, PrFile } from "@titan-design/github";
import type { ChangedFile, PrFacts } from "@titan-design/review-panel";

/** One pull request named on the command line, before its head is read. */
export interface PrTarget {
  /** `owner/repo`. */
  repo: string;
  pr: number;
}

const TARGET = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

/** Parses `owner/repo#N`; throws on anything else, including a PR number below 1. */
export function parseTarget(text: string): PrTarget {
  const match = TARGET.exec(text);
  const pr = Number(match?.[3]);
  if (match === null || !Number.isSafeInteger(pr) || pr < 1) throw new Error(`expected owner/repo#N, got ${JSON.stringify(text)}`);
  return { repo: `${match[1]}/${match[2]}`, pr };
}

const changedFileOf = ({ path, previousPath, additions, deletions }: PrFile): ChangedFile => ({
  path,
  ...(previousPath !== undefined && { previousPath }),
  additions: additions ?? Number.NaN,
  deletions: deletions ?? Number.NaN,
});

/** An unreadable list throws: an empty one in its place would class a large PR as standard. */
async function changedFiles(port: Pick<GitHubPort, "listPrFiles">, { repo, pr }: PrTarget): Promise<ChangedFile[]> {
  try {
    return (await port.listPrFiles(repo, pr)).map(changedFileOf);
  } catch (error) {
    throw new Error(`cannot read the changed files of ${repo}#${pr}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function headOf(port: Pick<GitHubPort, "getPr">, { repo, pr }: PrTarget, head: string | undefined): Promise<string> {
  if (head === undefined) return (await port.getPr(repo, pr)).headSha;
  if (!SHA.test(head)) throw new Error(`--head must be a full 40-character lowercase sha, got ${JSON.stringify(head)}`);
  return head;
}

/**
 * The PR's facts as the panel classifies them. `base` is empty because classification never reads it; an absent
 * `kind` classes the PR g10, as the panel's rules intend for an unread kind.
 */
export async function readPrFacts(port: Pick<GitHubPort, "getPr" | "listPrFiles">, target: PrTarget, options: { head?: string; kind?: string } = {}): Promise<PrFacts> {
  const head = await headOf(port, target, options.head);
  const files = await changedFiles(port, target);
  return { ...target, head, base: "", ...(options.kind !== undefined && { kind: options.kind }), changedFiles: files };
}
