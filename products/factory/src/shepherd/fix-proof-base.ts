import { parseResultLine } from "@titan-design/fix-proof";
import type { z } from "zod";
import type { FixProofReadSchema } from "./fix-proof.js";

type FixProofRead = z.infer<typeof FixProofReadSchema>;

/**
 * The base the read was bound to, which its MERGE records as `proofBase`; trust plays no part in it. A read taken between #2550
 * and `boundBase` names the base through its line instead. A read with no binding (skipped, an unreadable gate) names none.
 */
export function proofBaseOf(read: FixProofRead, head: string): string | undefined {
  if (read.kind === "workflow-ci") return read.head === head && typeof read.baseRef === "string" ? read.baseRef : undefined;
  if (typeof read.boundBase === "string") return read.boundBase;
  return judgedBaseOf(read, head);
}

/** The base a run actually judged: a result or untrusted line's `base`, or the base a workflow-ci read cited, at this head. */
export function judgedBaseOf(read: FixProofRead, head: string): string | undefined {
  if (read.kind === "workflow-ci") return read.head === head && typeof read.baseRef === "string" ? read.baseRef : undefined;
  if ((read.kind !== "result" && read.kind !== "untrusted") || typeof read.line !== "string") return undefined;
  const parsed = parseResultLine(read.line);
  return parsed.ok && parsed.result.head === head ? parsed.result.base : undefined;
}
