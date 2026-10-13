#!/usr/bin/env node
// Renders a codewatch-pr-report@1 file as a short markdown summary for $GITHUB_STEP_SUMMARY, or with --annotate
// as GitHub workflow commands on stdout.
// Always exits 0: dag-check owns the job's verdict, and may have failed before writing the report.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const short = (sha) => (sha ? sha.slice(0, 12) : "none");

export function renderSummary(report) {
  const { check } = report;
  const verdict = check.passed ? "passed" : "failed";
  const lines = [
    "## codewatch report",
    "",
    `Check ${verdict}: ${check.newErrors} new error(s), ${check.newWarnings} new warning(s), ${check.carryover} carryover.`,
    `Head \`${short(report.head)}\` against base \`${short(report.base)}\`.`,
    `${report.deltas.length} metric delta(s), ${report.exports.length} export change(s).`,
  ];
  const questions = report.questions ?? [];
  if (questions.length > 0) lines.push("", "### Questions", "", ...questions.map((q) => `- ${q}`));
  const slice = sliceNotice(report.size);
  if (slice) lines.push("", `### ${slice.title}`, "", slice.message);
  return `${lines.join("\n")}\n`;
}

const UNKNOWN_SIZE = {
  title: "Security slice size unknown",
  message: "The report has no size block (no baseline, a numstat failure or a file without line counts), so the security slice cap was not checked. Read the diff size by hand.",
};

// A missing size is surfaced, never silent: silence would read the same as a small PR.
function sliceNotice(size) {
  if (!size) return UNKNOWN_SIZE;
  if (!size.flagged) return undefined;
  const where = size.guardPaths.length > 0 ? ` It touches ${size.guardPaths.join(", ")}.` : "";
  const message = `This guard-area PR is ${size.lines} non-generated lines, over the ${size.cap}-line security slice cap.${where} Split the parser or list change from its wiring.`;
  return { title: "Security slice over cap", message };
}

/** Workflow commands for the job log: one warning for an oversize guard-area PR or an unknown size, none otherwise. */
export function annotations(report) {
  const slice = sliceNotice(report?.size);
  return slice ? [`::warning title=${slice.title}::${escapeCommand(slice.message)}`] : [];
}

function escapeCommand(text) {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function readReport(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A missing or unreadable report has no size either, so it annotates as unknown. */
export function annotateFile(file) {
  let report;
  try {
    report = readReport(file);
  } catch {
    report = undefined;
  }
  return annotations(report).map((line) => `${line}\n`).join("");
}

export function summarizeFile(file) {
  if (!file || !existsSync(file)) return `## codewatch report\n\nNo report was written: dag-check stopped before it got there.\n`;
  try {
    return renderSummary(readReport(file));
  } catch (err) {
    return `## codewatch report\n\nThe report could not be read: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const annotate = process.argv[2] === "--annotate";
  const file = process.argv[annotate ? 3 : 2];
  process.stdout.write(annotate ? annotateFile(file) : summarizeFile(file));
}
