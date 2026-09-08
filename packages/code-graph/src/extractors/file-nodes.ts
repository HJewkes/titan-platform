import * as path from "node:path";
import { getLanguageFromPath } from "../parser/index.js";
import { fileId, moduleId, parentModuleId } from "./ids.js";
import type { GraphNode } from "../types.js";

/**
 * Build the `file` + `module` nodes for a source file from its path alone.
 * Path-derived and deterministic, so the incremental indexer can reconstruct an
 * unchanged file's nodes without re-parsing it — they are byte-for-byte the same
 * nodes the extractor would emit. Keep this the single source of truth for
 * file/module node shape.
 */
export function buildFileModuleNodes(repoRoot: string, absPath: string): GraphNode[] {
  const fId = fileId(repoRoot, absPath);
  const mId = moduleId(repoRoot, absPath);
  const parentId = parentModuleId(mId) ?? undefined;
  const language = getLanguageFromPath(absPath) ?? "typescript";
  return [
    { id: fId, kind: "file", name: path.basename(fId), parentId: mId, language },
    { id: mId, kind: "module", name: path.basename(mId), parentId, language },
  ];
}
