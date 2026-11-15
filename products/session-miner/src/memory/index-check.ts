import { parseMemoryIndex } from "@titan-design/memory";

/** Claude Code loads only this many lines of MEMORY.md into context; pointers past it are invisible to the model. */
export const INDEX_LOAD_LINE_LIMIT = 200;

const MEMORY_INDEX = "MEMORY.md";

interface PointerRef {
  file: string;
  line: number;
}

export interface IndexCheck {
  dangling: PointerRef[];
  unindexed: string[];
  unloaded: PointerRef[];
}

/** Compares an index against the `.md` file names beside it. Names and line numbers only, never fact text. */
export function checkIndex(indexRaw: string, factFileNames: readonly string[]): IndexCheck {
  const pointers = parseMemoryIndex(indexRaw);
  const present = new Set(factFileNames);
  const named = new Set(pointers.map(({ file }) => file));
  return {
    dangling: pointers.filter(({ file }) => !present.has(file)).map(({ file, line }) => ({ file, line })),
    unindexed: factFileNames.filter((name) => name !== MEMORY_INDEX && name.endsWith(".md") && !named.has(name)),
    unloaded: pointers.filter(({ line }) => line > INDEX_LOAD_LINE_LIMIT).map(({ file, line }) => ({ file, line })),
  };
}
