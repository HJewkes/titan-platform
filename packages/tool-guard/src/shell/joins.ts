/**
 * Bash drops each backslash-newline before it reads a token, outside single quotes, `$'…'`, comments and the
 * bodies of quoted here-documents. Every reader that looks past the character it stands on goes through these,
 * so `$(\<NL>(`, `(\<NL>(`, `&\<NL>&` and `<\<NL><` read as bash reads them.
 */

/** Sources whose join runs were measured; bounded, since nested readers lex slices of one command. */
const RUN_ENDS = new Map<string, Int32Array>();
const MAX_SOURCES = 64;

/** The first index at or after `at` that does not start a backslash-newline, in constant time once `src` is measured. */
export function pastJoins(src: string, at: number): number {
  if (!src.startsWith("\\\n", at)) return at;
  return runEnds(src)[at] ?? at;
}

/** For every index, where the run of backslash-newlines starting there ends: one backward pass, so lookaheads stay linear. */
function runEnds(src: string): Int32Array {
  const known = RUN_ENDS.get(src);
  if (known) return known;
  const ends = new Int32Array(src.length + 2);
  ends[src.length] = src.length;
  ends[src.length + 1] = src.length + 1;
  for (let i = src.length - 1; i >= 0; i--) ends[i] = src.startsWith("\\\n", i) ? (ends[i + 2] ?? i) : i;
  if (RUN_ENDS.size >= MAX_SOURCES) RUN_ENDS.clear();
  RUN_ENDS.set(src, ends);
  return ends;
}

/** Index of the character bash reads after the one at `at`. */
export function nextAfter(src: string, at: number): number {
  return pastJoins(src, at + 1);
}

/** Where the `$` at `j` stands once bash drops the backslash-newlines after it, so `$\<NL>[` opens `$[`. */
export function joinedDollar(src: string, j: number): number {
  return nextAfter(src, j) - 1;
}

/** Up to `n` characters bash reads from `at` on, with `ends[k]` the raw index just past the first `k + 1` of them. */
export function readAhead(src: string, at: number, n: number): { text: string; ends: number[] } {
  let text = "";
  const ends: number[] = [];
  for (let j = pastJoins(src, at); text.length < n && j < src.length; j = nextAfter(src, j)) {
    text += src[j];
    ends.push(j + 1);
  }
  return { text, ends };
}

/** `text` with the backslash-newlines bash drops removed; an escaped backslash before a newline stays. */
export function dropJoins(text: string): string {
  return text.replace(/\\([\s\S])/g, (pair, next: string) => (next === "\n" ? "" : pair));
}

/** How many backslashes end `text`; an odd count leaves the last one unescaped, so the line continues. */
export function trailingBackslashes(text: string): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === "\\") count++;
  return count;
}
