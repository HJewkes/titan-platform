export interface SquashCommit {
  readonly subject: string;
  readonly body: string;
}

export interface SquashInput {
  readonly title: string;
  readonly body: string;
  readonly prNumber: number;
  readonly taskIds: readonly string[];
  readonly commits: readonly SquashCommit[];
}

export interface SquashMessage {
  readonly subject: string;
  readonly body: string;
}

const EMAIL = /[ \t]*<?[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}>?/g;
const DROPPED_LINES = [/^\s*(?:co-authored-by|signed-off-by):/i, /^\s*(?:🤖\s*)?Generated with \[Claude Code\]/u];
// GitHub's squash body puts this line between the commits and the trailers it collects.
const GITHUB_SEPARATOR = /^-{9,}$/;
const GITHUB_COMMIT_HEADER = /^\* \S/;
const MAIN_MERGE = /^Merge (?:remote-tracking branch |branch )?'?(?:origin\/)?main'?(?: of \S+)?(?: into \S.*)?$/;
const FENCE = /^\s*(?:```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Pure: the same input always yields byte-identical output, and re-formatting its own output changes nothing. */
export function formatSquashMessage(input: SquashInput): SquashMessage {
  const taskIds = uniqueIds(input.taskIds);
  const refs = `Refs: ${[...taskIds, `#${input.prNumber}`].join(", ")}`;
  const bullets = input.commits.flatMap((commit) => changeBullet(commit) ?? []);
  const tail = bullets.length > 0 ? `## Changes\n\n${bullets.join("\n")}\n\n${refs}` : refs;
  const summary = summaryOf(input.body, tail);
  const body = summary ? `## Summary\n\n${summary}\n\n${tail}` : tail;
  return { subject: subjectOf(input.title, input.prNumber, taskIds), body };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
}

function subjectOf(title: string, prNumber: number, taskIds: readonly string[]): string {
  const suffix = ` (#${prNumber})`;
  const cleaned = oneLine(title.replace(EMAIL, ""));
  const base = cleaned.endsWith(suffix) ? cleaned.slice(0, -suffix.length) : cleaned;
  const missing = taskIds.filter((id) => !mentions(base, id));
  const tasks = missing.length > 0 ? ` (${missing.join(", ")})` : "";
  return `${base}${tasks}${suffix}`;
}

function mentions(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`).test(text);
}

/**
 * The PR body without a leading "## Summary" heading. Only the exact Changes and Refs tail this
 * call would write is cut, so the formatter's own output round-trips and an author's text never loses a section.
 */
function summaryOf(body: string, tail: string): string {
  const text = cleanText(body);
  if (text === tail) return "";
  const untailed = text.endsWith(`\n\n${tail}`) ? text.slice(0, -(tail.length + 2)) : text;
  return untailed.replace(/^## Summary(?:\n+|$)/, "").trim();
}

function changeBullet(commit: SquashCommit): string | undefined {
  const subject = oneLine(commit.subject.replace(EMAIL, ""));
  if (subject === "" || MAIN_MERGE.test(subject)) return undefined;
  const bold = `**${/[.!?]$/.test(subject) ? subject : `${subject}.`}**`;
  const [first, ...rest] = blocks(unheaderSquash(cleanText(commit.body))).map(reflow);
  const text = [first ? `${bold} ${first}` : bold, ...rest].join("\n\n");
  const lines = text.split("\n").map((line, i) => (i === 0 || line === "" ? line : `  ${line}`));
  return `- ${lines.join("\n")}`;
}

function cleanText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !DROPPED_LINES.some((pattern) => pattern.test(line)))
    .map((line) => line.replace(EMAIL, "").trimEnd());
  while (lines.at(-1) === "") lines.pop();
  if (GITHUB_SEPARATOR.test(lines.at(-1) ?? "")) lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Only a body GitHub squashed opens with a "* <subject>" header; elsewhere a star line is the author's list. */
function unheaderSquash(text: string): string {
  const lines = text.split("\n");
  if (!isSquashHeader(lines, 0)) return text;
  return lines.map((line, i) => (isSquashHeader(lines, i) ? line.slice(2) : line)).join("\n");
}

function isSquashHeader(lines: readonly string[], i: number): boolean {
  const alone = (line: string | undefined): boolean => line === undefined || line === "";
  return GITHUB_COMMIT_HEADER.test(lines[i] ?? "") && alone(lines[i - 1]) && alone(lines[i + 1]);
}

/** Blank-line separated blocks; a fenced code block stays whole across its own blank lines. */
function blocks(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (line.trim() === "" && !inFence) {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function reflow(block: readonly string[]): string {
  const keepLines = block.some((line) => FENCE.test(line) || LIST_ITEM.test(line));
  return keepLines ? block.join("\n") : oneLine(block.join(" "));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
