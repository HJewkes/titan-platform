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
  if (report.size?.flagged) lines.push("", "### Security slice over cap", "", sliceMessage(report.size));
  return `${lines.join("\n")}\n`;
}

function sliceMessage({ lines, cap, guardPaths }) {
  const where = guardPaths.length > 0 ? ` It touches ${guardPaths.join(", ")}.` : "";
  return `This guard-area PR is ${lines} non-generated lines, over the ${cap}-line security slice cap.${where} Split the parser or list change from its wiring.`;
}

/** Workflow commands for the job log: one warning for an oversize guard-area PR, none otherwise. */
export function annotations(report) {
  return report.size?.flagged ? [`::warning title=Security slice over cap::${escapeCommand(sliceMessage(report.size))}`] : [];
}

function escapeCommand(text) {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function readReport(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function annotateFile(file) {
  try {
    return annotations(readReport(file)).map((line) => `${line}\n`).join("");
  } catch {
    return "";
  }
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
