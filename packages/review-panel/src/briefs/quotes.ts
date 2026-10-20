const MAX_QUOTES = 3;
const MAX_QUOTE_CHARS = 120;
const QUOTES_HEADING = "These lines of your message caused it; reword each so it does not start with \"CI policy\" or \"Verdict\", or remove it:";

/** Reviewer text in argv, so it is cut, single-line and `> `-prefixed (never a verdict line), and dropped whole rather than push the prompt past `room`. */
export function quoteLines(quotes: readonly string[], room: number): string[] {
  const cut = quotes.slice(0, MAX_QUOTES).map((quote) => `> ${quote.replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE_CHARS)}`);
  const lines: string[] = [];
  let used = QUOTES_HEADING.length + 1;
  for (const line of cut) {
    if (used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? [QUOTES_HEADING, ...lines] : [];
}
