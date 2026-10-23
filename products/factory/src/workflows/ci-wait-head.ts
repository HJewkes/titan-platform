/**
 * The head each live ci-wait read last, keyed `repo#pr`. A ci-wait records its head only when it returns, so without this
 * a status read mid-wait names the head of an earlier step, not the moved head the wait is judging (TP-4092). In memory,
 * because only the live host's steps can be waiting, and never recorded, so a replay is unchanged.
 */
const heads = new Map<string, string>();

const keyOf = (repo: string, pr: number) => `${repo}#${pr}`;

export function noteCiWaitHead(repo: string, pr: number, headSha: string): void {
  heads.set(keyOf(repo, pr), headSha);
}

export function clearCiWaitHead(repo: string, pr: number): void {
  heads.delete(keyOf(repo, pr));
}

export function ciWaitHead(repo: string, pr: number | null): string | undefined {
  return pr === null ? undefined : heads.get(keyOf(repo, pr));
}
