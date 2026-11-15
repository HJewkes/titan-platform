import { posix } from "node:path";
import { MAX_REVIEWER_QUESTIONS } from "@titan-design/review-panel";

/** One reviewer question and the changed paths that make it worth asking. */
interface BankEntry {
  id: string;
  /** The entry applies when any changed path matches any of these globs. */
  pathGlobs: readonly string[];
  question: string;
}

/**
 * Entries are class-level questions written from scratch, never copied review text.
 * A question must stay one line with no verdict word, so it can sit in the brief beside the codewatch questions.
 */
export const QUESTION_BANK: readonly BankEntry[] = [
  {
    id: "readme-behaviour-claims",
    pathGlobs: ["**/README.md", "README.md", "site/guides/**"],
    question: "For each behaviour this doc now claims (a default, a limit, an ordering, a fallback), find the code that does it and say which line proves the claim; name any claim the code does not back.",
  },
  {
    id: "workflow-run-provenance",
    pathGlobs: ["**/*ci-reads*.ts", "**/*ci-proof*.ts", "**/gh-gateway*.ts", "**/main-ci-*.ts", "**/workflow-*.ts"],
    question: "Where this code reads a workflow run or check from the GitHub API, does it pin the run to the head sha, the workflow and the event, and does it reject a run whose fields are absent, stale or from another branch?",
  },
];

const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => posix.matchesGlob(path, glob));

/** The entries whose globs match a changed path, in bank order, once each, up to the brief's question cap. */
export function bankQuestions(changedPaths: readonly string[]): BankEntry[] {
  return QUESTION_BANK.filter((entry) => changedPaths.some((path) => matchesAny(path, entry.pathGlobs))).slice(0, MAX_REVIEWER_QUESTIONS);
}
