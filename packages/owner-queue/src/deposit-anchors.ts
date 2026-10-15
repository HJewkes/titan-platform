import { parseAnchor, verifyAnchorText, type AnchorPins, type RevisionSource } from "@titan-design/evidence";
import type { z } from "zod";

/** One anchor that held at its pinned commit, with its first and last lines quoted back. */
export interface QuotedAnchor {
  anchor: string;
  first: string;
  last: string;
}

interface AnchoredDeposit {
  anchors?: string[] | undefined;
  pins?: AnchorPins | undefined;
  options?: { anchors?: string[] | undefined }[] | undefined;
}

/** Thrown before anything is written, naming each anchor that does not hold at its pinned commit. */
export class DepositAnchorError extends Error {
  constructor(readonly refusals: readonly string[]) {
    super(`deposit refused: ${refusals.join("; ")}`);
    this.name = "DepositAnchorError";
  }
}

function anchorsOf(deposit: AnchoredDeposit): string[] {
  const all = [...(deposit.anchors ?? []), ...(deposit.options ?? []).flatMap((option) => option.anchors ?? [])];
  return [...new Set(all)];
}

/** Schema-level check: anchors need pins, and each must parse against them. No file is read. */
export function addAnchorIssues(deposit: AnchoredDeposit, ctx: z.RefinementCtx): void {
  const anchors = anchorsOf(deposit);
  if (anchors.length === 0) return;
  if (!deposit.pins) {
    ctx.addIssue({ code: "custom", path: ["pins"], message: "anchors need pins {repo, head, base?}" });
    return;
  }
  for (const text of anchors) {
    const parsed = parseAnchor(text, deposit.pins);
    if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["anchors"], message: `${text}: ${parsed.detail}` });
  }
}

/** Checks every anchor at its pinned commit; throws DepositAnchorError naming each that fails. */
export function verifyDepositAnchors(deposit: AnchoredDeposit, source: RevisionSource): QuotedAnchor[] {
  const { pins } = deposit;
  const anchors = anchorsOf(deposit);
  if (!pins || anchors.length === 0) return [];
  const quoted: QuotedAnchor[] = [];
  const refusals: string[] = [];
  for (const anchor of anchors) {
    const check = verifyAnchorText(anchor, pins, source);
    if (check.ok) quoted.push({ anchor, first: check.first, last: check.last });
    else refusals.push(check.detail);
  }
  if (refusals.length > 0) throw new DepositAnchorError(refusals);
  return quoted;
}
