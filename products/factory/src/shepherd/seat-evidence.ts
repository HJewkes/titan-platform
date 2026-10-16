import { parseVerdictBlock } from "@titan-design/session-read";
import type { ReviewTarget, ReviewerMessage } from "@titan-design/review-panel";
import type { SeatRow } from "./seat-tie.js";

/** A stopped reviewer's transcript that ends in a partial record; `readable` and `brief` are what its complete records said. */
export class DamagedTranscriptError extends Error {
  readonly readable: readonly ReviewerMessage[];
  readonly brief: string | null;

  constructor(message: string, readable: readonly ReviewerMessage[], brief: string | null = null) {
    super(message);
    this.name = "DamagedTranscriptError";
    this.readable = readable;
    this.brief = brief;
  }
}

/** One name's sessions, each read on its own: what every complete record said, the reads that failed, and the rows they failed for. */
export interface NameRead {
  messages: readonly ReviewerMessage[];
  failures: readonly unknown[];
  failedRows: readonly SeatRow[];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` names this PR as `<owner>/<repo>#<n>` or `<repo>#<n>`, the repo in any letter case. */
function namesPr(target: ReviewTarget, text: string): boolean {
  const [owner = "", repo = ""] = target.repo.split("/");
  const pattern = new RegExp(`(?:^|[^\\w./-])(?:${escaped(owner)}/)?${escaped(repo)}#${target.pr}(?!\\d)`, "i");
  return pattern.test(text);
}

/** A brief naming this PR, or a verdict block naming it at any head, marks the reviewer as the PR's own. */
export function reviewsThisPr(target: ReviewTarget, read: NameRead): boolean {
  const briefs = read.failures.flatMap((failure) => (failure instanceof DamagedTranscriptError && failure.brief !== null ? [failure.brief] : []));
  if (briefs.some((brief) => namesPr(target, brief))) return true;
  return read.messages.some((message) => {
    const block = parseVerdictBlock(message.text);
    return "repo" in block && block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr;
  });
}

/** A PR named with its repo or alias (`demo#5`, `tp#5`) or as a pull URL path (`pull/5`). */
const NAMED_PR = /(?:[\w.-]#|pull\/)(\d+)(?!\d)/g;
/** Any number a brief may use for a PR, a bare `#5` included. */
const MAYBE_PR = /(?:#|pull\/)(\d+)(?!\d)/g;

const numbers = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => Number(match[1]));

/** A brief naming some PR, none of whose refs may be this one: an alias or a bare `#<n>` with this PR's number could be this PR. */
function briefNamesOtherPr(target: ReviewTarget, brief: string): boolean {
  return numbers(brief, NAMED_PR).some((pr) => pr !== target.pr) && !numbers(brief, MAYBE_PR).includes(target.pr);
}

/**
 * What a failed session's own complete records showed: a brief naming another PR, or a verdict block naming one with another
 * number. A hard failure has no records, and a sibling session under the same name may be a resume reviewing this PR, so neither is evidence.
 */
export function ownRecordsNameOtherPr(target: ReviewTarget, failure: unknown): boolean {
  if (!(failure instanceof DamagedTranscriptError)) return false;
  if (failure.brief !== null && briefNamesOtherPr(target, failure.brief)) return true;
  return failure.readable.some((message) => {
    const block = parseVerdictBlock(message.text);
    return "repo" in block && block.pr !== target.pr;
  });
}
