import type { WordToken } from "./lexer.js";

/** The option that ends a short cluster and its attached text, as `splitCluster` reads it. */
type ClusterEnd = { option: string; text: string } | null | undefined;

/**
 * The `-I` replace string and the BSD `-J` insert string of xargs's options, each the last one given. xargs honours
 * only the last of `-I` and `-J`, so `insert` is dropped by a later `-I`; `replace` keeps an earlier `-I`, so main's
 * per-line runs are still read beside the `-J` ones and no verdict is lost.
 */
export function replaceStrings(options: WordToken[], endOf: (word: string) => ClusterEnd) {
  let replace: string | null = null;
  let insert: string | null = null;
  options.forEach((word, j) => {
    const next = options[j + 1]?.value;
    const end = endOf(word.value);
    if (end?.option === "J") insert = end.text || (next ?? null);
    const found = wordReplace(word.value, end, next);
    if (found !== null) [replace, insert] = [found, null];
  });
  return { replace, insert };
}

/** The replace string of `-I str`, `-Istr`, `-i[str]`, `--replace[=str]` or a cluster such as `-tI{}`, `{}` when none is given. */
function wordReplace(v: string, end: ClusterEnd, next: string | undefined): string | null {
  if (v === "--replace") return "{}";
  if (v.startsWith("--replace=")) return v.slice("--replace=".length);
  if (end?.option === "I") return end.text || (next ?? null);
  return end?.option === "i" ? end.text || "{}" : null;
}
