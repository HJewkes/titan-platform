import { revisionLineSource } from "@titan-design/code-graph/history";
import { isFullSha } from "@titan-design/evidence";
import type { HeadLines } from "./codewatch-questions.js";
import { cacheFor, ensureCache, must, serialized, type CarryOptions } from "./tree-carry.js";

/**
 * File lines at the PR head, read from Shepherd's bare git cache and never a working tree. Registration usually fetched the
 * head already; when it did not (its file read fell back to REST), the head is fetched by sha. An unreadable head rejects.
 */
export function cacheHeadLines(options: CarryOptions): HeadLines {
  return async ({ repo, head }) => {
    if (!isFullSha(head)) throw new Error("the head is not a 40-hex commit id");
    const cache = cacheFor(repo, options);
    const { git, dir, url } = cache;
    return serialized(dir, async () => {
      await ensureCache(cache, options.signal);
      const present = await git(dir, ["cat-file", "-e", `${head}^{commit}`], options.signal);
      if (present.code !== 0) await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, head], options.signal);
      return revisionLineSource(dir, head);
    });
  };
}
