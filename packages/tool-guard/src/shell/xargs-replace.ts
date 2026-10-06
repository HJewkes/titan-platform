import type { WordToken } from "./lexer.js";

/** The option that ends a short cluster and its attached text, as `splitCluster` reads it. */
type ClusterEnd = { option: string; text: string } | null | undefined;

interface OptionReader {
  endOf: (word: string) => ClusterEnd;
  takesValue: (word: string) => boolean;
}

/**
 * The `-I` replace string and the BSD `-J` insert string of xargs's options, each the last one given. xargs honours
 * only the last of `-I` and `-J`, so `insert` is dropped by a later `-I`; `replace` keeps an earlier `-I`, so its
 * per-line runs are still read beside the `-J` ones. A word an option takes as its value is not an option, so `-J -i`
 * inserts at `-i`, as getopt reads it. `replaceAsOption` is the replace string read when such a word is taken as an
 * option instead, which is how the guard read it before; its runs are read too, so no verdict loosens.
 */
export function replaceStrings(options: WordToken[], reader: OptionReader) {
  const { replace, insert } = readStrings(options, reader, true);
  return { replace, insert, replaceAsOption: readStrings(options, reader, false).replace };
}

function readStrings(options: WordToken[], { endOf, takesValue }: OptionReader, skipValues: boolean) {
  let replace: string | null = null;
  let insert: string | null = null;
  for (let j = 0; j < options.length; j++) {
    const v = (options[j] as WordToken).value;
    const next = options[j + 1]?.value;
    const end = endOf(v);
    if (end?.option === "J") insert = end.text || (next ?? null);
    const found = wordReplace(v, end, next);
    if (found !== null) [replace, insert] = [found, null];
    if (skipValues && takesValue(v)) j++;
  }
  return { replace, insert };
}

/** The replace string of `-I str`, `-Istr`, `-i[str]`, `--replace[=str]` or a cluster such as `-tI{}`, `{}` when none is given. */
function wordReplace(v: string, end: ClusterEnd, next: string | undefined): string | null {
  if (v === "--replace") return "{}";
  if (v.startsWith("--replace=")) return v.slice("--replace=".length);
  if (end?.option === "I") return end.text || (next ?? null);
  return end?.option === "i" ? end.text || "{}" : null;
}
