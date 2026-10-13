import type { Runner } from "./runner.js";

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/** `owner/name` of a GitHub remote URL; undefined for any other remote. */
export const githubRepoOf = (url: string): string | undefined => GITHUB_REMOTE.exec(url.trim())?.[1];

export function originRepo(checkout: string, exec: Runner): string | undefined {
  const result = exec("git", ["-C", checkout, "remote", "get-url", "origin"]);
  return result.status === 0 ? githubRepoOf(result.stdout) : undefined;
}

/** One value per non-blank line of `gh --jq` output; a line that is not JSON reads as undefined, not a throw. */
export const jsonLines = (stdout: string): unknown[] =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseJson);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
