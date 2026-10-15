import type { LineRange } from "@titan-design/evidence";

// The lookbehind keeps a match from starting inside a word, a dotted version or a URL path.
const CITE = /(?<![\w./:@+~-])((?:[\w.@+-]+\/)*[\w.@+-]+):L(\d+)(?:-L?(\d+))?(?!\w)/g;
// A bare name needs a letter-led extension, so `v1.2:L3` is a version and not a file.
const FILE_NAME = /\.[A-Za-z]\w*$/;

function looksLikePath(path: string): boolean {
  return path.includes("/") || FILE_NAME.test(path);
}

/** Review citations (`path:L12`, `path:L12-L40`, `path:L12-40`) in text order, duplicates dropped. */
export function parseCites(text: string): LineRange[] {
  const seen = new Set<string>();
  const ranges: LineRange[] = [];
  for (const match of text.matchAll(CITE)) {
    const path = match[1]!;
    const lineStart = Number(match[2]);
    const lineEnd = match[3] === undefined ? lineStart : Number(match[3]);
    if (!looksLikePath(path) || lineStart < 1 || lineEnd < lineStart) continue;
    const key = `${path}:${lineStart}-${lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ path, lineStart, lineEnd });
  }
  return ranges;
}
