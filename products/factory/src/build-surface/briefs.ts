import { dataFence } from "@titan-design/agent-dispatch";
import type { GateRun, ReviewReport } from "./schemas.js";
import { branchOf, type BuildSpec, type Slice } from "./spec.js";

const REPORT_CONTRACT = [
  "When you are done, push your commits and end your final message with one fenced ```json block, and nothing after it:",
  '{"head": "<the full 40-character sha you pushed>", "targetsCovered": ["<case id>"], "newPrimitivesRequested": [], "deviations": [{"part": "<part>", "measurement": "<before -> after>"}], "ideas": [], "evidenceRun": "<path>"}',
  "A script checks that block against the pushed branch and the diff; the repo's gates, not your summary, decide whether the slice passes.",
].join("\n");

const REVIEW_CONTRACT = [
  "Change nothing. End your final message with one fenced ```json block, and nothing after it:",
  '{"head": "<the sha you reviewed>", "verdict": "PASS" | "BLOCK", "rows": [{"rubric": 1, "result": "pass" | "fail", "file": "<path>", "line": 1, "repro": "<command>"}]}',
  "Every fail row names a file and line inside the diff at that head and a runnable repro; a BLOCK with no such row is rejected.",
].join("\n");

/** The implementer's first brief: the slice's own text, where to push, the extracted targets as data, and the report contract. */
export function implementerBrief(spec: BuildSpec, slice: Slice, targets: unknown): string {
  const branch = branchOf(slice);
  const lines = [
    `Build slice "${slice.id}" (${slice.title}) of ${spec.repo}.`,
    `Work on branch ${branch}, which the workflow created from ${spec.base}: fetch it, commit on top of it, and push your commits to origin ${branch}. Open no PR; the workflow opens it.`,
    ...(slice.partition.length > 0 ? [`Keep the diff inside: ${slice.partition.join(", ")}.`] : []),
    "",
    dataFence("slice brief", slice.brief),
    ...(targets === undefined ? [] : ["", dataFence("targets", JSON.stringify(targets, null, 2))]),
    "",
    REPORT_CONTRACT,
  ];
  return lines.join("\n");
}

export function reviewerBrief(spec: BuildSpec, slice: Slice, head: string, rejections: readonly string[] = []): string {
  const lines = [
    `Review slice "${slice.id}" of ${spec.repo} at exactly head ${head} on branch ${branchOf(slice)}, against ${spec.base}, adversarially, using the repo's slop rubric.`,
    ...(rejections.length > 0 ? ["", dataFence("rejections of your last report", rejections.join("\n"))] : []),
    "",
    REVIEW_CONTRACT,
  ];
  return lines.join("\n");
}

export interface FixFindings {
  gates?: GateRun;
  preview?: { pass: boolean; detail: string };
  review?: ReviewReport;
  rejections?: readonly string[];
}

/** The fix round's message: what failed at which head, as data, and the same report contract. */
export function fixPacket(head: string, findings: FixFindings): string {
  const failing = findings.gates ? findings.gates.gates.filter((gate) => !gate.pass).map((gate) => `${gate.gate}${gate.score === undefined ? "" : ` (score ${gate.score})`}: ${gate.evidence}`) : [];
  const parts = [
    ...failing,
    ...(findings.gates?.problems ?? []),
    ...(findings.preview && !findings.preview.pass ? [`preview: ${findings.preview.detail}`] : []),
    ...(findings.review?.rows.filter((row) => row.result === "fail").map((row) => `review rubric ${row.rubric}: ${row.file ?? "?"}:${row.line ?? "?"} ${row.repro ?? ""}`.trim()) ?? []),
    ...(findings.rejections ?? []).map((rejection) => `report rejected: ${rejection}`),
  ];
  return [`Fix round at head ${head}. Fix what failed below, push, and report again.`, "", dataFence("findings", parts.join("\n")), "", REPORT_CONTRACT].join("\n");
}
