import { BLOCK_LINE, CI_UNREAD_LINE, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, findingsText } from "./fix-first-findings.js";
import { FOLLOW_UPS_HEADING } from "./follow-ups.js";
import { DEFECT_CLASS_HEADING, EARLIER_FINDINGS_HEADING } from "./reviewer-brief.js";

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const FIXED_ITEM = /^-\s+fixed:/;
const NOT_FIXED = /not fixed:/i;
const CI_POLICY_LINE = /^CI-policy:/;

/** A line that carries no finding: the CI-unread line itself, a one-line defect class, a fixed earlier item, or a verdict-block line. */
function carriesNoFinding(line: string): boolean {
  if (line === "" || line.replace(LIST_MARKER, "") === CI_UNREAD_LINE) return true;
  if (line.startsWith(DEFECT_CLASS_HEADING) || BLOCK_LINE.test(line) || CI_POLICY_LINE.test(line)) return true;
  return line === EARLIER_FINDINGS_HEADING || line === `${EARLIER_FINDINGS_HEADING} none found` || FIXED_ITEM.test(line);
}

/** Follow-ups never block, so the section, from its heading to the next blank line, is not read for findings. */
function withoutFollowUps(lines: readonly string[]): string[] {
  let inside = false;
  return lines.filter((line) => {
    if (line === FOLLOW_UPS_HEADING) inside = true;
    else if (line === "") inside = false;
    return !inside;
  });
}

/** One joined message holds only lines that carry no finding, and names the CI-unread line at least once. */
function onlyCiUnread(message: string): boolean {
  const lines = withoutFollowUps(findingsText(message).split("\n").map((line) => line.trim()));
  return lines.some((line) => line.replace(LIST_MARKER, "") === CI_UNREAD_LINE) && lines.every(carriesNoFinding);
}

/**
 * True when a FIX_FIRST's only blocking item is the CI-unread line. It is an allowlist, so any line it does not know, in any
 * form or section, may be a real finding and keeps the FIX_FIRST, as do a `not fixed:` earlier item and a cut that may have
 * dropped one. Each message joined into the findings is read on its own.
 */
export function ciUnreadOnly(text: string): boolean {
  if (text.includes(FIX_FIRST_TRUNCATED.trim()) || NOT_FIXED.test(text)) return false;
  return text.split(FINDINGS_SEPARATOR).every(onlyCiUnread);
}
