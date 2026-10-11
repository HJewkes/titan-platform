import { agentRunner, type AgentRunnerOptions, type LegacyStepRunner, type StepRoute, type StepRunOutcome } from "@titan-design/workflow";
import { z } from "zod";
import type { DocTask } from "./task-source.js";

const draftSchema = z.object({
  title: z.string().trim().min(1).max(72),
  summary: z.string().trim().min(1).max(1000),
  content: z.string().min(1),
});

/** A repo-relative path and the file's bytes at the base the draft starts from. */
export interface DocFile {
  path: string;
  content: string;
}

interface DraftRequest {
  task: DocTask;
  file: DocFile;
}

type DraftCheck = { ok: true } | { ok: false; reasons: string[] };

/** The claude-print harness runs with no tools, so the file's current content travels in the prompt. */
export function draftPrompt({ task, file }: DraftRequest): string {
  return [
    `Write a new version of the Markdown file ${file.path} so that this task is done.`,
    "You have no tools and must not try to read or edit files: the reply itself is the change.",
    `Task: ${task.title}`,
    `Done when: ${task.done_when}`,
    "Keep the front matter byte-identical and keep every existing heading. Change only what the task needs.",
    "Reply with the whole new file as content, a commit title under 72 characters, and a one-paragraph summary for the pull request.",
    `Current content of ${file.path}:`,
    file.content,
  ].join("\n\n");
}

interface DraftRouteOptions {
  cwd: string;
  /** The agent runner port; tests pass a fake so no model is ever called. */
  runnerFor?: (options: AgentRunnerOptions) => LegacyStepRunner;
}

/** One sonnet turn on the CLI login. A draft has no side effect, so a crash simply drafts again. */
export function draftRoute({ cwd, runnerFor = agentRunner }: DraftRouteOptions): StepRoute {
  const live = runnerFor({ cwd, maxTurns: 1, maxBudgetUsd: 0.5, defaults: { harness: "claude-print", model: "sonnet", outputSchema: draftSchema } });
  return { match: "draft", onRestart: "repeat", runner: { run: async (input) => parsedDraft(await live.run(input)) } };
}

/** Only zod's issue paths reach the error, never the model's text. */
function parsedDraft(outcome: StepRunOutcome): StepRunOutcome {
  if (!outcome.ok) return outcome;
  const parsed = draftSchema.safeParse(parseJson(outcome.output));
  if (parsed.success) return { ...outcome, output: JSON.stringify(parsed.data) };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  return { ok: false, error: `schema_invalid: draft (${issues})`, retryable: false, code: "schema_invalid", ...(outcome.usage ? { usage: outcome.usage } : {}) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pure: every reason the drafted content may not be published over `before`. */
export function checkDraft(before: DocFile, after: string, maxDeltaLines: number): DraftCheck {
  if (!isMarkdownPath(before.path)) return { ok: false, reasons: ["not a Markdown path"] };
  if (after === before.content) return { ok: false, reasons: ["content is unchanged"] };
  const reasons: string[] = [];
  if (frontMatter(after) !== frontMatter(before.content)) reasons.push("front matter changed");
  const kept = new Set(headings(after));
  reasons.push(...headings(before.content).filter((heading) => !kept.has(heading)).map((heading) => `section removed: ${heading}`));
  if (addedLines(before.content, after).some(isOwnerData)) reasons.push("owner data in an added line");
  const delta = lineDelta(lines(before.content), lines(after));
  if (delta > maxDeltaLines) reasons.push(`${delta} changed lines exceed the bound of ${maxDeltaLines}`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isMarkdownPath(path: string): boolean {
  return path.endsWith(".md") && !path.startsWith("/") && !path.split("/").includes("..");
}

function frontMatter(content: string): string {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)?.[0] ?? "";
}

function lines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** Headings outside fenced code, since a `#` comment in a shell block is not a section. */
function headings(content: string): string[] {
  let fenced = false;
  return lines(content).filter((line) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,6}\s+\S/.test(line);
  }).map((line) => line.trim());
}

function addedLines(before: string, after: string): string[] {
  const old = new Set(lines(before));
  return lines(after).filter((line) => !old.has(line));
}

const HOME_PATH = /\/(?:Users|home)\/[^/\s]+/;
const EMAIL = /[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})/gi;
const DOC_DOMAINS = /(?:^|\.)example\.(?:com|org|net)$/i;

function isOwnerData(line: string): boolean {
  return HOME_PATH.test(line) || [...line.matchAll(EMAIL)].some((match) => !DOC_DOMAINS.test(match[1] ?? ""));
}

/** Lines removed plus lines added, over a longest common subsequence kept in two rows. */
function lineDelta(before: string[], after: string[]): number {
  let previous = new Array<number>(after.length + 1).fill(0);
  for (const line of before) {
    const current = [0];
    after.forEach((other, j) => current.push(line === other ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, current[j] ?? 0)));
    previous = current;
  }
  const common = previous[after.length] ?? 0;
  return before.length + after.length - 2 * common;
}
