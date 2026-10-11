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

/** One line of author text; `code` lines (fenced or indented) are never rewritten. */
interface Line {
  readonly text: string;
  readonly code: boolean;
}

type Block = readonly Line[];

// An address inside a URL, an ssh remote or a longer token is part of that token, so it is kept whole.
const EMAIL = /[ \t]*<?(?<![\w.%+/:@-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}>?(?![\w:/@-])/g;
const INLINE_CODE = /(`[^`]*`)/;
const TRAILER = /^\s*(?:co-authored-by|signed-off-by):/i;
const DROPPED_LINES = [TRAILER, /^\s*(?:🤖\s*)?Generated with \[Claude Code\]/u];
// GitHub writes "* <subject>" headers and this separator only into the body of a commit it squash-merged.
const GITHUB_SQUASH_SUBJECT = /\(#\d+\)$/;
const GITHUB_SEPARATOR = "---------";
const GITHUB_COMMIT_HEADER = /^\* \S/;
const MAIN_MERGE = /^Merge (?:remote-tracking branch |branch )?'?(?:origin\/)?main'?(?: of \S+)?(?: into \S.*)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/;
const STRUCTURE = [
  LIST_ITEM,
  SETEXT_UNDERLINE,
  /^ {0,3}#{1,6}(?:\s|$)/,
  /^ {0,3}>/,
  /^\s*\|/,
  /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/,
  /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/,
  /^ {0,3}</,
];

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
  const suffix = `(#${prNumber})`;
  const cleaned = oneLine(stripEmails(title));
  const base = cleaned === suffix || cleaned.endsWith(` ${suffix}`) ? cleaned.slice(0, -suffix.length).trim() : cleaned;
  const missing = taskIds.filter((id) => !mentions(base, id));
  const tasks = missing.length > 0 ? `(${missing.join(", ")})` : "";
  return [base, tasks, suffix].filter((part) => part !== "").join(" ");
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
  const text = render(cleanBlocks(scan(body)));
  if (text === tail) return "";
  const untailed = text.endsWith(`\n\n${tail}`) ? text.slice(0, -(tail.length + 2)) : text;
  return untailed.replace(/^## Summary(?:\n+|$)/, "").trim();
}

function changeBullet(commit: SquashCommit): string | undefined {
  const subject = oneLine(stripEmails(commit.subject));
  if (subject === "" || MAIN_MERGE.test(subject)) return undefined;
  const bold = `**${/[.!?]$/.test(subject) ? subject : `${subject}.`}**`;
  const lines = scan(commit.body);
  const squashed = GITHUB_SQUASH_SUBJECT.test(subject) ? unsquash(lines) : lines;
  const blocks = cleanBlocks(squashed);
  const [first, ...rest] = blocks;
  const parts =
    first && opensWithProse(first) ? [`${bold} ${reflow(first)}`, ...rest.map(reflow)] : [bold, ...blocks.map(reflow)];
  const text = parts.join("\n\n").split("\n");
  return `- ${text.map((line, i) => (i === 0 || line === "" ? line : `  ${line}`)).join("\n")}`;
}

/** Normalised lines, each marked as code when it sits in a fence or is indented code. */
function scan(text: string): Line[] {
  let fence: string | undefined;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => {
      const line = raw.trimEnd();
      const marker = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && closes(marker, fence, line)) fence = undefined;
        return { text: line, code: true };
      }
      if (marker !== undefined) fence = marker;
      return { text: line, code: marker !== undefined || INDENTED_CODE.test(line) };
    });
}

function closes(marker: string, fence: string, line: string): boolean {
  return marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker;
}

/** Trailers, the Claude line and emails go from prose only; blank runs between blocks collapse, code keeps its own. */
function cleanBlocks(lines: readonly Line[]): Block[] {
  const out: Line[][] = [[]];
  for (const line of lines) {
    if (!line.code && DROPPED_LINES.some((pattern) => pattern.test(line.text))) continue;
    const text = line.code ? line.text : stripEmails(line.text).trimEnd();
    if (text.trim() === "" && !line.code) out.push([]);
    else out[out.length - 1]?.push({ text, code: line.code });
  }
  return out.filter((block) => block.length > 0);
}

function render(blocks: readonly Block[]): string {
  return blocks.map((block) => block.map((line) => line.text).join("\n")).join("\n\n");
}

function stripEmails(text: string): string {
  return text
    .split(INLINE_CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(EMAIL, "")))
    .join("");
}

/** GitHub's squash body: drop its trailing separator and the star of each "* <subject>" header standing alone. */
function unsquash(lines: readonly Line[]): Line[] {
  const at = lines.findIndex((line, i) => !line.code && line.text === GITHUB_SEPARATOR && onlyTrailersAfter(lines, i));
  const kept = at === -1 ? lines : lines.slice(0, at);
  return kept.map((line, i) => (isSquashHeader(kept, i) ? { ...line, text: line.text.slice(2) } : line));
}

function onlyTrailersAfter(lines: readonly Line[], i: number): boolean {
  const after = lines.slice(i + 1).filter((line) => line.text !== "");
  return after.length > 0 && after.every((line) => TRAILER.test(line.text));
}

function isSquashHeader(lines: readonly Line[], i: number): boolean {
  const alone = (line: Line | undefined): boolean => line === undefined || line.text === "";
  const line = lines[i];
  return !!line && !line.code && GITHUB_COMMIT_HEADER.test(line.text) && alone(lines[i - 1]) && alone(lines[i + 1]);
}

function isProse(line: Line): boolean {
  return !line.code && !STRUCTURE.some((pattern) => pattern.test(line.text));
}

/** A block can follow the bold subject on its line only when it opens as a paragraph. */
function opensWithProse(block: Block): boolean {
  const [first, second] = block;
  return !!first && isProse(first) && !(second && SETEXT_UNDERLINE.test(second.text));
}

/** Only a plain paragraph is joined onto one line; any markdown structure or code keeps the author's lines. */
function reflow(block: Block): string {
  const texts = block.map((line) => line.text);
  return block.every(isProse) ? oneLine(texts.join(" ")) : texts.join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
