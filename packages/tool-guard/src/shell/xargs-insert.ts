import type { WordToken } from "./lexer.js";

export function literalWord(value: string): WordToken {
  return { type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
}

/**
 * The runs BSD `xargs -J` makes: each group of input items, all of them, in place of the first argument that
 * is exactly the insert string. When no argument is, xargs appends the items, even after an earlier `-I`,
 * whose replace mode `-J` switches off.
 */
export function insertRuns(args: WordToken[], insert: string | null, groups: string[][]): WordToken[][] {
  if (insert === null) return [];
  const at = args.findIndex((a) => a.value === insert);
  if (at < 0) return groups.map((items) => [...args, ...items.map(literalWord)]);
  return groups.map((items) => [...args.slice(0, at), ...items.map(literalWord), ...args.slice(at + 1)]);
}
