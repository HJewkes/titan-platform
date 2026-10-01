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

export const OUTCOMES = ["accept", "amend", "other", "redirect", "none"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface OutcomeInput {
  answer: string | null;
  /** Option labels as the asker wrote them, "(Recommended)" suffix included. */
  options: readonly string[];
  recommended: string | null;
  /** A v1 row's pick type; when present it decides everything except amend against redirect. */
  pickType?: PickType;
}

const RECOMMENDED_MARK = /\s*\(recommended\)\s*/gi;
const QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
];

export function stripRecommended(label: string): string {
  return label.replace(RECOMMENDED_MARK, " ").trim();
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
  rejected: "other",
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

/** The scored outcome of an answer; null means unparsed, which stays out of scoring. */
export function classifyOutcome({ answer, options, recommended, pickType }: OutcomeInput): Outcome | null {
  if (pickType !== undefined) {
    const mapped = FROM_PICK_TYPE[pickType];
    return mapped === "free_text" ? amendOrRedirect(answer, recommended) : mapped;
  }
  return answer === null ? null : fromAnswer(answer, options, recommended);
}
