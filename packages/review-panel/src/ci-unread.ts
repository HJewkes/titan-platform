import { CI_UNREAD_LINE, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED } from "./fix-first-findings.js";
import { FOLLOW_UPS_HEADING, FOLLOW_UP_SEVERITIES } from "./follow-ups.js";
import { DEFECT_CLASS_HEADING, EARLIER_FINDINGS_HEADING } from "./reviewer-brief.js";

const CI_POLICY_KEYS = "required-check|permissions|pull_request_target|secrets|ruleset|other";
const CI_LINE = new RegExp(`^(?:(?:[-*+]|\\d+[.)])[ \\t]+)?${CI_UNREAD_LINE}$`);

/** Every line a CI-unread-only FIX_FIRST may hold, each in its one exact shape; nothing here can carry a finding. */
const TEMPLATE: readonly RegExp[] = [
  /^$/,
  CI_LINE,
  /^Verdict: FIX_FIRST$/,
  /^PR: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/,
  /^Head: [0-9a-f]{40}$/,
  /^Closer: (?:yes|no)$/,
  new RegExp(`^CI-policy: (?:unchanged|weakened (?:${CI_POLICY_KEYS})(?:, ?(?:${CI_POLICY_KEYS}))*)$`),
  new RegExp(`^${DEFECT_CLASS_HEADING} CI unread\\.?$`),
  new RegExp(`^${EARLIER_FINDINGS_HEADING} none found$`),
  new RegExp(`^${FOLLOW_UPS_HEADING} none$`),
];

/** A bare heading opens the only place a follow-up item may stand: the unbroken run of items directly below it. */
const FOLLOW_UPS_OPEN = new RegExp(`^${FOLLOW_UPS_HEADING}$`);
/** Title and doneWhen hold no `|`, no control character and no line or paragraph separator, so one item is one line. */
const ITEM_TEXT = "[^|\\p{Cc}\\u0085\\u2028\\u2029]+";
const FOLLOW_UP_ITEM = new RegExp(`^- ${ITEM_TEXT} \\| ${ITEM_TEXT} \\| (?:${FOLLOW_UP_SEVERITIES.join("|")})$`, "u");
/** An earlier finding's resolution is never a follow-up, whatever shape it is written in. */
const RESOLUTION_TITLE = /^- *(?:not +)?fixed:/i;

const isFollowUpItem = (line: string): boolean => FOLLOW_UP_ITEM.test(line) && !RESOLUTION_TITLE.test(line);
const lineFits = (line: string): boolean => TEMPLATE.some((shape) => shape.test(line));

/** Every line fits the template, or is a follow-up item inside the run that a bare `Follow-ups:` heading opens. */
function linesFit(lines: readonly string[]): boolean {
  let inFollowUps = false;
  for (const line of lines) {
    if (inFollowUps && isFollowUpItem(line)) continue;
    inFollowUps = FOLLOW_UPS_OPEN.test(line);
    if (!inFollowUps && !lineFits(line)) return false;
  }
  return true;
}

/** One joined message, read raw, fits the template line by line and names the CI-unread line itself. */
function fitsTemplate(message: string): boolean {
  const lines = message.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  return lines.some((line) => CI_LINE.test(line)) && linesFit(lines);
}

/**
 * True only when every line of every joined message is one of the template's exact shapes and each message names the
 * CI-unread line (TP-3050). It is structural, not a list of lookalikes: any other line, a `fixed:` earlier item included,
 * may be a finding and keeps the FIX_FIRST, as does a cut that may have dropped one. A kept FIX_FIRST only wakes a fixer.
 */
export function ciUnreadOnly(text: string): boolean {
  const normalised = text.replace(/\r\n/g, "\n");
  if (normalised.trim() === "" || normalised.includes(FIX_FIRST_TRUNCATED.trim())) return false;
  return normalised.split(FINDINGS_SEPARATOR).every(fitsTemplate);
}
