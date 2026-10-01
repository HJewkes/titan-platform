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

/** Free text is an amend when it starts with or quotes the recommended label, else a redirect. */
function amendOrRedirect(answer: string | null, recommended: string | null): Outcome {
  const label = recommended === null ? "" : normalize(recommended);
  if (answer === null || label === "") return "redirect";
  const text = answer.trim().toLowerCase();
  if (text.startsWith(label)) return "amend";
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

function isListed(answer: string, options: readonly string[]): boolean {
  const labels = options.map(normalize);
  // Multi-select answers join the picked labels with ", ".
  return labels.includes(answer) || answer.split(", ").every((part) => labels.includes(part));
}

function fromAnswer(answer: string, options: readonly string[], recommended: string | null): Outcome {
  const text = normalize(answer);
  if (recommended !== null && text === normalize(recommended)) return "accept";
  return isListed(text, options) ? "other" : amendOrRedirect(answer, recommended);
}

/** The scored outcome of an answer; null means unparsed, which stays out of scoring. */
export function classifyOutcome({ answer, options, recommended, pickType }: OutcomeInput): Outcome | null {
  if (pickType !== undefined) {
    const mapped = FROM_PICK_TYPE[pickType];
    return mapped === "free_text" ? amendOrRedirect(answer, recommended) : mapped;
  }
  return answer === null ? null : fromAnswer(answer, options, recommended);
}
