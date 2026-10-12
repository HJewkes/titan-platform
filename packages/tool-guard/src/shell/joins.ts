/**
 * Bash drops each backslash-newline before it reads a token, outside single quotes, `$'…'`, comments and the
 * bodies of quoted here-documents. Every reader that looks past the character it stands on goes through these,
 * so `$(\<NL>(`, `(\<NL>(`, `&\<NL>&` and `<\<NL><` read as bash reads them.
 */

/** The first index at or after `at` that does not start a backslash-newline. */
export function pastJoins(src: string, at: number): number {
  let past = at;
  while (src.startsWith("\\\n", past)) past += 2;
  return past;
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

/** A line ending in a backslash that no other backslash escapes continues on the next line. */
export function endsInJoin(line: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
}
