import type { TermRule } from "./rules.js";

/** A term-file problem. The message names the line number only, never the term. */
export class TermFileError extends Error {
  constructor(
    readonly line: number,
    reason: string,
  ) {
    super(`private term list line ${line}: ${reason}`);
    this.name = "TermFileError";
  }
}

const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function compileRegex(source: string, line: number): RegExp {
  if (source === "") throw new TermFileError(line, "empty regular expression");
  try {
    return new RegExp(source, "iu");
  } catch {
    // The engine's message quotes the pattern, so it is dropped rather than wrapped.
    throw new TermFileError(line, "invalid regular expression");
  }
}

function compileTerm(entry: string, line: number): RegExp {
  if (entry.startsWith("re:")) return compileRegex(entry.slice(3), line);
  return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(entry)}(?!${WORD_CHAR})`, "iu");
}

/**
 * Parses a private term list: one term per line, `#` comments, blank lines ignored, matched
 * case-insensitively on word boundaries; a `re:` line is a regex source compiled with `iu`.
 */
export function parseTerms(text: string): TermRule[] {
  const rules: TermRule[] = [];
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const entry = raw.trim();
      if (entry === "" || entry.startsWith("#")) return;
      const pattern = compileTerm(entry, i + 1);
      if (pattern.test("")) throw new TermFileError(i + 1, "matches the empty string, so it would match every line");
      rules.push({
        index: i + 1,
        matches: (candidate) => pattern.test(candidate),
        search: (candidate) => candidate.search(pattern),
      });
    });
  return rules;
}
