import { execFileSync } from "node:child_process";

/** Runs `gh` with the given arguments and returns its stdout; throws on a non-zero exit. */
export type GhExec = (args: readonly string[]) => string;

/** The shape of `@titan-design/evidence`'s `LineSource`, which the panel's citation check reads. */
export interface GhLineSource {
  lines(path: string): readonly string[] | undefined;
}

/** Shepherd's `MAX_CITED_FILES`: a review that cites more files than this is not worth more reads. */
export const MAX_READ_FILES = 20;

const MAX_FILE_BYTES = 16 * 1024 * 1024;

const ghExec: GhExec = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_FILE_BYTES, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function contentsArgs(repo: string, head: string, path: string): string[] {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(head)}`];
}

/**
 * File text at `head`, read through `gh api` only when the citation check asks for it, once per path. A path it cannot
 * read, or one past the first {@link MAX_READ_FILES}, is undefined, which drops only the findings that cite it.
 */
export function ghLineSource(repo: string, head: string, exec: GhExec = ghExec): GhLineSource {
  const read = new Map<string, string[] | undefined>();
  return {
    lines(path) {
      if (read.has(path)) return read.get(path);
      if (read.size >= MAX_READ_FILES) return undefined;
      let lines: string[] | undefined;
      try {
        lines = splitLines(exec(contentsArgs(repo, head, path)));
      } catch {
        lines = undefined;
      }
      read.set(path, lines);
      return lines;
    },
  };
}
