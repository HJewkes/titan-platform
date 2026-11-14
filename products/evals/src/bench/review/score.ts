import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { splitLines, verifyCitation, type LineSource } from "@titan-design/evidence";
import { findingsText } from "@titan-design/review-panel";
import { parseVerdictBlock } from "@titan-design/session-read";
import { citesPath } from "../../corpus/cited-paths.js";
import type { CaseType, ReviewCaseBody } from "./cases.js";

/** `path:12` or `path:12-30`, the form review-panel's aggregate and `scoreReplay` read a finding's citations in. */
const CITATION = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w*):(\d+)(?:-(\d+))?/g;
/** How far a cited line may sit from a planted line and still name it. */
export const PLANTED_LINE_SLACK = 3;

export interface Cited {
  path: string;
  lineStart: number;
  lineEnd: number;
}

export interface ReviewResult {
  caseType: CaseType;
  verdict: "MERGE" | "FIX_FIRST" | null;
  /** The final message held no well-formed block naming this case's PR and head. */
  contract: boolean;
  contractReason?: string;
  /** Defect and planted cases only. */
  caught: boolean | null;
  /** Clean cases only. */
  falseAlarm: boolean | null;
  /** A FIX_FIRST's citations that resolve at the head; the false-alarm judge reads them. */
  cited: Cited[];
}

/** File text at the bundle's head, refusing any path that climbs out of it. */
export function headLineSource(headDir: string): LineSource {
  const root = resolve(headDir);
  return {
    lines(path) {
      const full = resolve(root, path);
      if (!full.startsWith(root + sep) || !existsSync(full)) return undefined;
      try {
        return splitLines(readFileSync(full, "utf8"));
      } catch {
        return undefined;
      }
    },
  };
}

/** Reviewers reading a bundle may cite `head/src/x.ts:4` or the bundle's absolute path; both name `src/x.ts`. */
function repoRelative(message: string, bundleDir: string): string {
  const absolute = `${bundleDir.replace(/\/+$/, "")}/`;
  return message.split(`${absolute}head/`).join("").split(absolute).join("").replace(/(?<![\w./-])head\//g, "");
}

function verifiedCitations(findings: string, source: LineSource): Cited[] {
  const found = [...findings.matchAll(CITATION)].flatMap(([, path = "", start = "", end]) => {
    const cited = { path, lineStart: Number(start), lineEnd: Number(end ?? start) };
    // Reviewers quote nothing, so reaching the quote step means the path and lines were confirmed.
    const check = verifyCitation(source, { ...cited, quote: "" });
    return check.ok || check.reason === "quote-empty" ? [cited] : [];
  });
  return [...new Map(found.map((cited) => [`${cited.path}:${cited.lineStart}-${cited.lineEnd}`, cited])).values()];
}

const nearLine = (cited: Cited, line: number): boolean => line >= cited.lineStart - PLANTED_LINE_SLACK && line <= cited.lineEnd + PLANTED_LINE_SLACK;

/** A verified citation that names a gold path, and for a planted defect also lands within the slack of its line. */
function namesGold(body: ReviewCaseBody, cited: readonly Cited[]): boolean {
  return cited.some((entry) => body.gold.some((gold) => citesPath(entry.path, gold.path) && (gold.line === undefined || nearLine(entry, gold.line))));
}

const targetOf = (body: ReviewCaseBody) => ({ repo: body.repo, pr: body.pr, head: body.head });

function contractFailure(body: ReviewCaseBody, reason: string): ReviewResult {
  const applies = body.caseType === "clean";
  return { caseType: body.caseType, verdict: null, contract: true, contractReason: reason, caught: applies ? null : false, falseAlarm: applies ? false : null, cited: [] };
}

/**
 * Scores one review's final message. No block, a malformed one, a WAIT or a block naming another target is a contract
 * failure, never a catch and never a false alarm.
 */
export function scoreReview(body: ReviewCaseBody, message: string | undefined, bundleDir: string): ReviewResult {
  const text = repoRelative(message ?? "", bundleDir);
  const block = parseVerdictBlock(text);
  if (!block.ok) return contractFailure(body, block.reason);
  const target = targetOf(body);
  if (block.repo !== target.repo || block.pr !== target.pr || block.head !== target.head) return contractFailure(body, "wrong_target");
  const fixFirst = block.verdict === "FIX_FIRST";
  const cited = fixFirst ? verifiedCitations(findingsText(text), headLineSource(`${bundleDir}/head`)) : [];
  const clean = body.caseType === "clean";
  return { caseType: body.caseType, verdict: block.verdict, contract: false, caught: clean ? null : fixFirst && namesGold(body, cited), falseAlarm: clean ? fixFirst : null, cited };
}

/** The text of the transcript's last assistant message that says anything, joined across its content lines. */
export function finalMessage(transcriptText: string): string | undefined {
  const lines = transcriptText.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { type?: string; message?: { id?: string; content?: unknown } }];
    } catch {
      return [];
    }
  });
  const texts = lines.filter((line) => line.type === "assistant").map((line) => ({ id: line.message?.id, text: textOf(line.message?.content) }));
  const last = texts.filter((entry) => entry.text !== "").at(-1);
  if (last === undefined) return undefined;
  if (last.id === undefined) return last.text;
  return texts.filter((entry) => entry.id === last.id && entry.text !== "").map((entry) => entry.text).join("\n");
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .flatMap((block: unknown) => (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}
