import { homedir } from "node:os";
import path from "node:path";
import type { Label } from "../pairs.js";
import type { ToolUse } from "../corpus/transcripts.js";

/**
 * Turning an opened file into the vocabularies a retriever answers in.
 *
 * `active-work search` returns a workspace-relative `path` and a `ref`; the
 * transcript only ever has an absolute path. Matching on the absolute form
 * alone would score every retriever at zero, so a label carries all three and
 * a hit counts if it names any of them.
 */

export function defaultActiveRoot(home = homedir()): string {
  return path.join(home, "Library", "Application Support", "active-work");
}

/** The tools whose `file_path` counts as "the agent went and opened this". */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

export function labelledPathOf(tool: ToolUse): string | undefined {
  if (!FILE_TOOLS.has(tool.name)) return undefined;
  const filePath = tool.input.file_path ?? tool.input.notebook_path;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return undefined;
  return path.normalize(filePath);
}

/**
 * `<slug>/sources/notes/<file>` is a note, `<slug>/sources/<file>` a source,
 * `<slug>/tasks/<ID>.yml` a task. Anything else under the root is workspace
 * content with no ref, and anything outside it is repo code with neither.
 */
export function normaliseLabel(absolute: string, activeRoot: string): Label {
  const relative = path.relative(activeRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { absolute };
  const ref = refOf(relative);
  return { absolute, relative, ...(ref ? { ref } : {}) };
}

function refOf(relative: string): string | undefined {
  const parts = relative.split(path.sep);
  const [slug, kind, ...rest] = parts;
  if (slug === undefined || kind === undefined || rest.length === 0) return undefined;
  if (kind === "sources" && rest[0] === "notes" && rest.length === 2) return `note:${slug}/${rest[1]}`;
  if (kind === "sources" && rest.length === 1) return `source:${slug}/${rest[0]}`;
  if (kind === "tasks" && rest.length === 1 && rest[0]!.endsWith(".yml")) {
    return `task:${path.basename(rest[0]!, ".yml")}`;
  }
  return undefined;
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
