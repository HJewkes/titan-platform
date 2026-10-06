import type { WordToken } from "./lexer.js";

export function literalWord(value: string): WordToken {
  return { type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
}

/**
 * The runs BSD `xargs -J` makes: each group of input items, all of them, in place of the first argument that
 * is exactly the insert string. None when no argument is, as the appended reading then covers the run.
 */
export function insertRuns(args: WordToken[], insert: string | null, groups: string[][]): WordToken[][] {
  const at = insert === null ? -1 : args.findIndex((a) => a.value === insert);
  if (at < 0) return [];
  return groups.map((items) => [...args.slice(0, at), ...items.map(literalWord), ...args.slice(at + 1)]);
}
