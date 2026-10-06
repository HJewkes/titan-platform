const WORD = /(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\])+/g;
const QUOTING = /'([^']*)'|"([^"]*)"|\\(.)/g;

/**
 * The input as xargs reads it without `-0` or `-d`: quotes group blanks and are dropped, and a backslash keeps the
 * next character. Empty when no quote or backslash is in the lines, as the plain blank split already reads them.
 */
export function quotedReadings(lines: string[]): string[][][] {
  if (!lines.some((line) => /["'\\]/.test(line))) return [];
  return [lines.map(quotedWords).filter((words) => words.length > 0)];
}

function quotedWords(line: string): string[] {
  return (line.match(WORD) ?? []).map((word) => word.replace(QUOTING, (_m, single = "", double = "", escaped = "") => single + double + escaped));
}
