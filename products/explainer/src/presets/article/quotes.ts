import { QUOTE_MAX_WORDS } from "./schemas.js";

// Typographic quotes, dashes and line breaks differ between a PDF's text and a hand-typed quote without changing it.
export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const isShortQuote = (text: string, maxWords = QUOTE_MAX_WORDS): boolean => wordCount(text) <= maxWords;

/** Whether `quote` appears word for word in `source`, up to whitespace and typography. */
export const isVerbatim = (quote: string, source: string): boolean => normalizeText(source).includes(normalizeText(quote));

/** Whether the quote states the number: its digits appear in the quote, so a number claim cannot cite unrelated text. */
export function quoteStates(quote: string, value: number): boolean {
  const digits = normalizeText(quote).replace(/(\d),(\d{3})/g, "$1$2");
  return new RegExp(`(^|[^\\d.])${String(value).replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(digits);
}
