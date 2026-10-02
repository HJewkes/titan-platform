const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PR_URL = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/gi;
const PR_HASH = /\b(?:[\w.-]+\/)?([\w.-]+)#(\d+)\b/g;
const PR_ARGS = /\b[\w-]+\/([\w.-]+) (\d+)\b/g;

/** The PR key drops the owner, so `owner/name#N`, `name#N` and a pull URL for the same PR compare equal. */
export function prKey(repo: string, pr: number | string): string {
  return `pr:${repo.split("/").pop()!.toLowerCase()}#${pr}`;
}

export const runKey = (runId: string): string => `run:${runId.toLowerCase()}`;

/** Every run id and PR reference a free-text line names, as de-duplication keys. */
export function keysIn(text: string): string[] {
  const keys = [...text.matchAll(UUID)].map((m) => runKey(m[0]));
  for (const pattern of [PR_URL, PR_HASH, PR_ARGS]) keys.push(...[...text.matchAll(pattern)].map((m) => prKey(m[1]!, m[2]!)));
  return [...new Set(keys)];
}

/** `owner/name#N` for a pull URL, else the text unchanged. */
export function refOfUrl(url: string): string {
  const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}
