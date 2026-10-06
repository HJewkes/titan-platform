/** active-work's v1 `pick_type`, kept so v1 precedent rows still classify. */
export const PICK_TYPES = [
  "recommended",
  "other_option",
  "free_text",
  "rejected",
  "unparsed",
  "none",
] as const;
export type PickType = (typeof PICK_TYPES)[number];

/** `bulk` is one answer that accepted several decisions at once; it is never per-item evidence. */
export const OUTCOMES = ["accept", "amend", "other", "redirect", "none", "bulk"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface OutcomeInput {
  answer: string | null;
  /** Option labels as the asker wrote them, any "recommend" marker included. */
  options: readonly string[];
  recommended: string | null;
  /** A v1 row's pick type; when present it decides everything except amend against redirect. */
  pickType?: PickType;
}

const BRACKETED = /\s*[([{]([^)\]}]*)[)\]}]/g;
const PREFIX_MARK = /^\s*recommend(?:ed)?(?:\s*:|\s+[-–—|])\s*/i;
const SUFFIX_MARK = /(?:\s*:|\s+[-–—|])\s*recommend(?:ed)?\s*$/i;
const NEGATED = /\b(?:not|never|un|non|less)[\s-]*recommend|n't\s+recommend/i;
const QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
];

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPositiveMark(content: string): boolean {
  return /recommend/i.test(content) && !NEGATED.test(content);
}

/**
 * Removes the asker's recommendation marker: a bracketed group containing "recommend", or
 * "Recommended" set off by a colon or a spaced dash as prefix or suffix. A negated marker
 * ("not recommended") is not a recommendation and stays.
 */
export function stripRecommended(label: string): string {
  const unbracketed = label.replace(BRACKETED, (group, content: string) => (isPositiveMark(content) ? " " : group));
  return squash(unbracketed.replace(PREFIX_MARK, " ").replace(SUFFIX_MARK, " "));
}

/** The one definition of a recommended option: its label carries a marker `stripRecommended` removes. */
export function isRecommendedLabel(label: string): boolean {
  return stripRecommended(label) !== squash(label);
}

function normalize(text: string): string {
  return stripRecommended(text).toLowerCase();
}

/** A prefix match that ends on a word boundary, so "use a queueing" does not start with "use a queue". */
function startsWithWord(text: string, label: string): boolean {
  return text.startsWith(label) && !/^\w/.test(text.slice(label.length));
}

/** Free text is an amend when it starts with or quotes the recommended label, else a redirect. */
function amendOrRedirect(answer: string | null, recommended: string | null): Outcome {
  const label = recommended === null ? "" : normalize(recommended);
  if (answer === null || label === "") return "redirect";
  const text = answer.trim().toLowerCase();
  if (startsWithWord(text, label)) return "amend";
  return QUOTES.some(([open, close]) => text.includes(`${open}${label}${close}`))
    ? "amend"
    : "redirect";
}

const FROM_PICK_TYPE: Record<PickType, Outcome | "free_text" | null> = {
  recommended: "accept",
  other_option: "other",
  rejected: null,
  free_text: "free_text",
  unparsed: null,
  none: "none",
};

/** True when the answer is one whole label or a multi-select of whole labels joined by commas. */
function isListed(answer: string, options: readonly string[]): boolean {
  const labels = options.map(normalize);
  if (labels.includes(normalize(answer))) return true;
  const parts = answer.split(",").map(normalize);
  return parts.length > 1 && parts.every((part) => labels.includes(part));
}

function fromAnswer(answer: string, options: readonly string[], recommended: string | null): Outcome {
  if (recommended !== null && normalize(answer) === normalize(recommended)) return "accept";
  return isListed(answer, options) ? "other" : amendOrRedirect(answer, recommended);
}

/** The scored outcome of an answer; null means unparsed or declined, which stays out of scoring. */
export function classifyOutcome({ answer, options, recommended, pickType }: OutcomeInput): Outcome | null {
  if (pickType !== undefined) {
    const mapped = FROM_PICK_TYPE[pickType];
    return mapped === "free_text" ? amendOrRedirect(answer, recommended) : mapped;
  }
  return answer === null ? null : fromAnswer(answer, options, recommended);
}
