import path from "node:path";
import type { Label } from "../pairs.js";
import type { ToolUse } from "../corpus/transcripts.js";
import { pathToRef } from "../workspace-layout.js";

/**
 * Turning an opened file into the vocabularies a retriever answers in.
 *
 * `active-work search` returns a workspace-relative `path` and a `ref`; the
 * transcript only ever has an absolute path. Matching on the absolute form
 * alone would score every retriever at zero, so a label carries all three and
 * a hit counts if it names any of them.
 */

/** The tools whose `file_path` counts as "the agent went and opened this". */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

export function labelledPathOf(tool: ToolUse): string | undefined {
  if (!FILE_TOOLS.has(tool.name)) return undefined;
  const filePath = tool.input.file_path ?? tool.input.notebook_path;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return undefined;
  return path.normalize(filePath);
}

/**
 * A file under the root gets a relative path and, when it has a ref shape, a
 * ref; anything outside it is repo code with neither.
 */
export function normaliseLabel(absolute: string, activeRoot: string): Label {
  const relative = path.relative(activeRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { absolute };
  const ref = pathToRef(relative);
  return { absolute, relative, ...(ref ? { ref } : {}) };
}

/** Deduplicate by absolute path, keeping first-seen order so a diff stays readable. */
export function dedupeLabels(labels: Label[]): Label[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    if (seen.has(label.absolute)) return false;
    seen.add(label.absolute);
    return true;
  });
}
