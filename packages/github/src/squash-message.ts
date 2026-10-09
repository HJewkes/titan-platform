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
const DROPPED_LINES = [
  /^\s*(?:co-authored-by|signed-off-by):/i,
  /^\s*(?:🤖\s*)?Generated with \[Claude Code\]/u,
  /^-{4,}\s*$/,
];
// GitHub's default squash body heads each commit with "* <subject>" and a blank line.
const GITHUB_COMMIT_HEADER = /^\* (.+)$/;
const MAIN_MERGE = /^Merge (?:remote-tracking branch |branch )?'?(?:origin\/)?main'?(?: into \S.*)?$/;
const FENCE = /^\s*(?:```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Pure: the same input always yields byte-identical output, and re-formatting its own output changes nothing. */
export function formatSquashMessage(input: SquashInput): SquashMessage {
  const taskIds = uniqueIds(input.taskIds);
  const refs = `Refs: ${[...taskIds, `#${input.prNumber}`].join(", ")}`;
  const summary = summaryOf(input.body, refs);
  const bullets = input.commits.flatMap((commit) => changeBullet(commit) ?? []);
  const sections: string[] = [];
  if (summary) sections.push(`## Summary\n\n${summary}`);
  if (bullets.length > 0) sections.push(`## Changes\n\n${bullets.join("\n")}`);
  sections.push(refs);
  return { subject: subjectOf(input.title, input.prNumber, taskIds), body: sections.join("\n\n") };
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

/** The PR body, minus the headings and Refs line this formatter adds, so its own output round-trips. */
function summaryOf(body: string, refs: string): string {
  const lines = cleanText(body).split("\n");
  const start = lines[0] === "## Summary" ? 1 : 0;
  const changesAt = lines.indexOf("## Changes");
  const kept = lines.slice(start, changesAt < 0 ? lines.length : changesAt);
  if (kept.at(-1) === refs) kept.pop();
  return kept.join("\n").trim();
}

function changeBullet(commit: SquashCommit): string | undefined {
  const subject = oneLine(commit.subject.replace(EMAIL, ""));
  if (subject === "" || MAIN_MERGE.test(subject)) return undefined;
  const bold = `**${/[.!?]$/.test(subject) ? subject : `${subject}.`}**`;
  const [first, ...rest] = blocks(cleanText(commit.body)).map(reflow);
  const text = [first ? `${bold} ${first}` : bold, ...rest].join("\n\n");
  const lines = text.split("\n").map((line, i) => (i === 0 || line === "" ? line : `  ${line}`));
  return `- ${lines.join("\n")}`;
}

function cleanText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = lines.filter((line) => !DROPPED_LINES.some((pattern) => pattern.test(line)));
  const tidy = kept.map((line, i) => unheader(line, kept[i + 1]).replace(EMAIL, "").trimEnd());
  return tidy.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function unheader(line: string, next: string | undefined): string {
  const header = GITHUB_COMMIT_HEADER.exec(line);
  return header && (next === undefined || next.trim() === "") ? header[1]! : line;
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
