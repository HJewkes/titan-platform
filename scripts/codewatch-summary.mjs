#!/usr/bin/env node
// Renders a codewatch-pr-report@1 file as a short markdown summary for $GITHUB_STEP_SUMMARY.
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
  return `${lines.join("\n")}\n`;
}

export function summarizeFile(file) {
  if (!file || !existsSync(file)) return `## codewatch report\n\nNo report was written: dag-check stopped before it got there.\n`;
  try {
    return renderSummary(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    return `## codewatch report\n\nThe report could not be read: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(summarizeFile(process.argv[2]));
