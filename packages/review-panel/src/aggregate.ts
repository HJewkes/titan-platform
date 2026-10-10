import { verifyCitation, type LineSource } from "@titan-design/evidence";
import type { AwaitVerdictResult } from "./accept-verdict.js";
import { FINDINGS_SEPARATOR, MAX_FIX_FIRST_TEXT_CHARS, boundedFindings } from "./fix-first-findings.js";
import { DEFAULT_SONNET_FOR } from "./plan.js";
import { DEFECT_CLASS_HEADING } from "./reviewer-brief.js";
import type { PanelFinding, PanelMember, PanelOutcome, PanelPlan, PanelVerdict, ReviewShape } from "./types.js";

/** One member's result: its accepted verdict, `none` when it gave none after its fresh retry, or `timeout`. */
export interface MemberResult {
  shape: ReviewShape;
  result: AwaitVerdictResult | { kind: "timeout" };
  /** Retried at sonnet because opus was refused at spawn. */
  degraded?: boolean;
}

export interface AggregateInput {
  /** The head every counted verdict must name. */
  head: string;
  /** File text at the head; advisory findings whose citations it cannot confirm are dropped. */
  source: LineSource;
  /** fix-proof's verdict for the PR when one ran; `vacuous` or `no-tests` makes the tests member blocking. */
  fixProof?: string;
  /** The opus profiles, as `planPanel`'s policy lists them; satisfiesG10 needs the correctness member at one. */
  sonnetFor?: Record<string, string>;
}

type Status = "MERGE" | "FIX_FIRST" | "missing" | "timeout";

interface Seat {
  member: PanelMember;
  blocking: boolean;
  status: Status;
  fixFirsts: readonly { text: string; closer?: "yes" | "no" }[];
}

const SHAPE_ORDER: readonly ReviewShape[] = ["correctness", "adversary", "tests", "visual", "perf"];
const BAD_FIX_PROOF = new Set(["vacuous", "no-tests"]);
const CITATION = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w*):(\d+)(?:-(\d+))?/g;
const FINDING_START = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Results may come back from stored JSON, so a verdict counts only when it is exactly MERGE or FIX_FIRST at the head. */
const verdictAt = (result: MemberResult["result"], head: string): unknown => (result.kind === "verdict" && result.head === head ? (result as { verdict?: unknown }).verdict : undefined);

function statusOf(results: readonly MemberResult[], head: string): Status {
  const verdicts = results.map((r) => verdictAt(r.result, head));
  if (verdicts.includes("FIX_FIRST")) return "FIX_FIRST";
  if (verdicts.length > 0 && verdicts.every((v) => v === "MERGE")) return "MERGE";
  return results.length > 0 && results.every((r) => r.result.kind === "timeout") ? "timeout" : "missing";
}

function fixFirstsOf(results: readonly MemberResult[], head: string): Seat["fixFirsts"] {
  return results.flatMap(({ result }) => {
    if (verdictAt(result, head) !== "FIX_FIRST" || !("text" in result)) return [];
    const closer = result.closer === "yes" || result.closer === "no" ? result.closer : undefined;
    return [{ text: typeof result.text === "string" ? result.text : "", ...(closer && { closer }) }];
  });
}

const badFixProof = (input: AggregateInput): boolean => typeof input.fixProof === "string" && BAD_FIX_PROOF.has(input.fixProof.trim().toLowerCase());

function seatOf(member: PanelMember, results: readonly MemberResult[], input: AggregateInput): Seat {
  const own = results.filter((r) => r.shape === member.shape);
  const blocking = member.blocking || (member.shape === "tests" && badFixProof(input));
  return { member, blocking, status: statusOf(own, input.head), fixFirsts: fixFirstsOf(own, input.head) };
}

/** A tests seat a bad fix-proof requires but the plan never scheduled has no verdict to count, so it is missing. */
const UNPLANNED_TESTS: Seat = {
  member: { shape: "tests", profile: "", briefId: "", blocking: true, degraded: false },
  blocking: true,
  status: "missing",
  fixFirsts: [],
};

/** The blocking set comes from the plan plus evidence that arrived after planning, so fix-proof can only make the verdict stricter. */
function seatsOf(plan: PanelPlan, results: readonly MemberResult[], input: AggregateInput): Seat[] {
  const seats = plan.members.map((m) => seatOf(m, results, input));
  if (badFixProof(input) && !seats.some((s) => s.member.shape === "tests")) seats.push(UNPLANNED_TESTS);
  return seats.sort((a, b) => SHAPE_ORDER.indexOf(a.member.shape) - SHAPE_ORDER.indexOf(b.member.shape));
}

/** Any blocking FIX_FIRST blocks; MERGE needs every blocking member's MERGE at the head; anything else is never consent. */
function outcomeOf(blocking: readonly Seat[]): PanelOutcome {
  if (blocking.length === 0) return "no-verdict";
  if (blocking.some((s) => s.status === "FIX_FIRST")) return "FIX_FIRST";
  const absent = blocking.filter((s) => s.status !== "MERGE");
  if (absent.length === 0) return "MERGE";
  return absent.every((s) => s.status === "timeout") ? "timeout" : "no-verdict";
}

/** A finding starts at a blank line or a list item, so one reviewer's separate points are checked separately. */
function splitFindings(text: string): string[] {
  let current: string[] = [];
  const findings: string[][] = [current];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || (FINDING_START.test(line) && current.length > 0)) {
      current = [];
      findings.push(current);
    }
    if (line.trim() !== "") current.push(line);
  }
  return findings.filter((lines) => lines.length > 0).map((lines) => lines.join("\n"));
}

/** Verified when it cites at least one path:line and every citation exists at the head. */
function verified(finding: string, source: LineSource): boolean {
  const citations = [...finding.matchAll(CITATION)];
  return (
    citations.length > 0 &&
    citations.every(([, path = "", start = "", end]) => {
      // The reviewer quotes nothing, so a check that reaches the quote step has already confirmed the path and lines.
      const check = verifyCitation(source, { path, lineStart: Number(start), lineEnd: Number(end ?? start), quote: "" });
      return check.ok || check.reason === "quote-empty";
    })
  );
}

function memberText(seat: Seat, source: LineSource): string {
  const text = seat.fixFirsts.map((f) => f.text).join(FINDINGS_SEPARATOR);
  return seat.blocking ? text : splitFindings(text).filter((finding) => verified(finding, source)).join("\n\n");
}

/** The bound keeps the newest text; when that cuts the first cited line, it leads the result so the fixer still has a location. */
function boundMember(text: string, share: number): string {
  if (text.length <= share) return text;
  const lead = text.split("\n").find((line) => new RegExp(CITATION.source).test(line))?.slice(0, Math.floor(share / 4));
  const tail = boundedFindings(text, share);
  if (lead === undefined || tail.includes(lead)) return tail;
  return `${lead}\n${boundedFindings(text, share - lead.length - 1)}`;
}

/** Each member gets an equal share of the bound, so one long member does not crowd out another. */
function findingsOf(seats: readonly Seat[], source: LineSource): PanelFinding[] {
  const texts = seats.map((seat) => ({ seat, text: memberText(seat, source) })).filter(({ text }) => text !== "");
  const share = Math.floor(MAX_FIX_FIRST_TEXT_CHARS / Math.max(texts.length, 1));
  return texts.map(({ seat, text }) => ({ shape: seat.member.shape, text: boundMember(text, share), blocking: seat.blocking }));
}

function closerOf(dissent: readonly Seat[]): "yes" | "no" | undefined {
  const closers = dissent.flatMap((s) => s.fixFirsts.map((f) => f.closer));
  if (closers.includes("no")) return "no";
  return closers.includes("yes") ? "yes" : undefined;
}

function defectClassOf(dissent: readonly Seat[]): string | undefined {
  const line = dissent.flatMap((s) => s.fixFirsts.flatMap((f) => f.text.split("\n"))).find((l) => l.trim().startsWith(DEFECT_CLASS_HEADING));
  return line?.trim().slice(DEFECT_CLASS_HEADING.length).trim() || undefined;
}

function satisfiesG10(plan: PanelPlan, seats: readonly Seat[], outcome: PanelOutcome, degraded: readonly ReviewShape[], input: AggregateInput): boolean {
  const opusProfiles = input.sonnetFor ?? DEFAULT_SONNET_FOR;
  const correctness = seats.find((s) => s.member.shape === "correctness");
  const adversary = seats.find((s) => s.member.shape === "adversary");
  return (
    plan.class.class === "g10" &&
    outcome === "MERGE" &&
    degraded.length === 0 &&
    correctness?.status === "MERGE" &&
    Object.hasOwn(opusProfiles, correctness.member.profile) &&
    adversary?.status === "MERGE"
  );
}

/** The panel verdict for one head from its members' results. Every path it cannot classify ends short of MERGE. Pure. */
export function aggregate(plan: PanelPlan, results: readonly MemberResult[], input: AggregateInput): PanelVerdict {
  const seats = seatsOf(plan, results, input);
  const outcome = outcomeOf(seats.filter((s) => s.blocking));
  const dissent = seats.filter((s) => s.blocking && s.status === "FIX_FIRST");
  const degraded = seats.filter((s) => s.member.degraded || results.some((r) => r.shape === s.member.shape && r.degraded)).map((s) => s.member.shape);
  const closer = closerOf(dissent);
  const defectClass = defectClassOf(dissent);
  return {
    outcome,
    head: input.head,
    findings: findingsOf(seats, input.source),
    ...(defectClass !== undefined && { defectClass }),
    ...(closer !== undefined && { closer }),
    dissent: dissent.map((s) => s.member.shape),
    degraded,
    satisfiesG10: satisfiesG10(plan, seats, outcome, degraded, input),
  };
}
