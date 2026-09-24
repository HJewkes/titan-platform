/** Supplies file text by path, one entry per line with no terminators. Undefined means unreadable. */
export interface LineSource {
  lines(path: string): readonly string[] | undefined;
}

/** Splits text into lines, dropping the empty entry a trailing newline would leave. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A LineSource over in-memory text, keyed by path. */
export function lineSourceFromTexts(texts: Readonly<Record<string, string>>): LineSource {
  const cache = new Map<string, string[]>();
  return {
    lines(path) {
      if (!Object.hasOwn(texts, path)) return undefined;
      let lines = cache.get(path);
      if (!lines) {
        lines = splitLines(texts[path] as string);
        cache.set(path, lines);
      }
      return lines;
    },
  };
}
