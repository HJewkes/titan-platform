import type { Runner } from "./runner.js";

/** The owns a live holder has declared in a repo, which a new slice's owns must not overlap. */
export interface HeldOwns {
  holder: string;
  repo: string;
  owns: string[];
}

/** `id` as a whole token, any case: TP-40 never matches TP-400, and a branch's `cc-202` matches CC-202. */
export const namesId = (text: string, id: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i").test(text);

const TASK_ID = "[A-Za-z][A-Za-z0-9]*-\\d+";
const ID_SEPARATOR = "[ \\t]*(?:,[ \\t]*(?:and[ \\t]+)?|and[ \\t]+|&[ \\t]*)";
// A clause opens a line, a list bullet or a sentence, so "Partly covers" and "This covers" stay prose.
const COVERS_CLAUSE = new RegExp(
  `(?:^[ \\t]*(?:[-*][ \\t]+)?|\\.[ \\t]+)(?:Also covers|Covers):?[ \\t]+(${TASK_ID}(?:${ID_SEPARATOR}${TASK_ID})*)`,
  "gm",
);

/** Ids a body lists in a `Covers` or `Also covers` clause: a PR that says so delivers them too. */
export function coveredIds(body: string): string[] {
  const ids = [...body.matchAll(COVERS_CLAUSE)].flatMap((clause) => (clause[1] ?? "").match(new RegExp(TASK_ID, "g")) ?? []);
  return [...new Set(ids)];
}

/** The format `landingLines` parses: subject, unit separator, body, record separator. */
export const LANDING_LOG_FORMAT = "--format=%s%x1f%b%x1e";

/** Each commit's subject, then `<subject> [covers <ids>]` when its body has a Covers clause. */
export function landingLines(log: string): string[] {
  return log.split("\x1e").flatMap((record) => {
    const [head = "", body = ""] = record.split("\x1f");
    const subject = head.trim();
    if (subject.length === 0) return [];
    const covered = coveredIds(body);
    return covered.length === 0 ? [subject] : [subject, `${subject} [covers ${covered.join(", ")}]`];
  });
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits. `{owner}/{repo}` resolves from `cwd`.
const PULLS = "repos/{owner}/{repo}/pulls";

const FILES_JQ = ".[] | {filename, previous: (.previous_filename // null)}";

/**
 * Every path the PR touches. A rename yields its old path too, so a PR that moves a file still collides with work on
 * that file; a line that does not parse makes the whole list unreadable rather than short.
 */
export function readPrFiles(repo: string, pr: number, exec: Runner): string[] | undefined {
  const args = ["api", "--paginate", `${PULLS}/${pr}/files?per_page=100`, "--jq", FILES_JQ];
  const result = exec("gh", args, repo);
  if (result.status !== 0) return undefined;
  try {
    return jsonLines(result.stdout).flatMap(changedPaths);
  } catch {
    return undefined;
  }
}

function changedPaths(line: unknown): string[] {
  const { filename, previous } = (line ?? {}) as { filename?: unknown; previous?: unknown };
  if (typeof filename !== "string") throw new Error("PR file line without a filename");
  return typeof previous === "string" ? [previous, filename] : [filename];
}

const jsonLines = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
