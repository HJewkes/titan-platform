/**
 * Index of the `))` closing the arithmetic command `((` opened at `open`, or -1 when bash
 * would read the text as nested subshells instead. Like bash, it finds the `)` matching the
 * first `(` and calls the text arithmetic only when another `)` follows it at once.
 */
export function arithmeticEnd(src: string, open: number): number {
  let depth = 0;
  for (let j = open + 2; j < src.length; j = skipQuoted(src, j) + 1) {
    const c = src[j];
    if (c === "(") depth++;
    if (c === ")" && depth-- === 0) return src[j + 1] === ")" ? j : -1;
  }
  return -1;
}

/** Index of the last character of the escape or quoted string starting at `j`, else `j`. */
function skipQuoted(src: string, j: number): number {
  const c = src[j] as string;
  if (c === "\\") return j + 1;
  if (c === "'" || c === "`") return closingQuote(src, j, c);
  return c === '"' ? closingDouble(src, j) : j;
}

function closingQuote(src: string, start: number, quote: string): number {
  const end = src.indexOf(quote, start + 1);
  return end === -1 ? src.length : end;
}

function closingDouble(src: string, start: number): number {
  let j = start + 1;
  while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
  return j;
}
