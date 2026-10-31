import { formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import type { EvalCase } from "../spec/index.js";
import type { MemberScript, ReplayExpected, ReplayInput, Reply } from "./scenario.js";

const UNIT = { id: "review-workflow", version: "1.0.0" };
const PUBLIC_REPO = "HJewkes/titan-platform";
const SYNTHETIC_REPO = "acme/widgets";
const BASE = "b".repeat(40);

type Target = ReplayInput["target"];

const block = (verdict: "MERGE" | "FIX_FIRST", { repo, pr, head }: Target): string => `Verdict: ${verdict}\nPR: ${repo}#${pr}\nHead: ${head}\n`;
/** Every reply carries a Probes line, which an adversary's verdict needs and correctness ignores. */
const merges = (target: Target): Reply => ({ say: `Probes: drove the change past its edges.\n\n${block("MERGE", target)}` });
const fixFirst = (target: Target, finding: string): Reply => ({ say: `Probes: drove the change past its edges.\n\n1. ${finding}\n\n${block("FIX_FIRST", target)}` });
/** A member that writes the same reply on every attempt and correction. */
const always = (reply: Reply): MemberScript => ({ first: reply, corrected: reply, retry: reply });

interface CaseFacts {
  id: string;
  /** The public PR the case stands for; absent for a purely synthetic case. */
  ref?: string;
  tags: string[];
  input: ReplayInput;
  expected: ReplayExpected;
}

function evalCase({ id, ref, tags, input, expected }: CaseFacts): EvalCase {
  return {
    schema: "titan.case/v1",
    id,
    unit: UNIT,
    input,
    expected,
    split: "dev",
    tags,
    provenance: { source: "synthetic", ...(ref !== undefined && { ref }) },
    visibility: "public",
  };
}

interface SeedFacts {
  id: string;
  pr: number;
  head: string;
  path: string;
  /** Synthetic text standing for the file at the head, so a citation's lines can be checked. */
  source: string;
  verdict: "block" | "pass";
  outcome: "MERGE" | "FIX_FIRST";
  members: (target: Target) => Record<string, MemberScript>;
}

function seedCase(seed: SeedFacts): EvalCase {
  const target = { repo: PUBLIC_REPO, pr: seed.pr, head: seed.head };
  const input: ReplayInput = {
    target, base: BASE, kind: "feature", authorityTouch: true,
    changedFiles: [{ path: seed.path, additions: 12, deletions: 3 }],
    sources: { [seed.path]: seed.source }, proof: { kind: "skipped" }, uninstalled: [], members: seed.members(target),
  };
  return evalCase({ id: seed.id, ref: `tp#${seed.pr}`, tags: ["seed", seed.verdict], input, expected: { outcome: seed.outcome, verdict: seed.verdict, path: seed.path } });
}

const POLICY_PATH = "products/factory/src/required-checks-policy.ts";
const EVIDENCE_PATH = "products/factory/src/coordinator-evidence.ts";
const CONDITIONS_PATH = "packages/authority/src/conditions.ts";

const POLICY_SOURCE = [
  "export function readRequiredChecks(text: string): RequiredChecks | \"unreadable\" {",
  "  const parsed = JSON.parse(text) as { contexts?: string[] };",
  "  const contexts = parsed.contexts ?? [];",
  "  return { contexts };",
  "}",
].join("\n");
const EVIDENCE_SOURCE = [
  "export function abandonHead(gate: Gate, run: Run): string {",
  "  return run.head;",
  "}",
  "export const ABANDON_REASONS = [\"ci-failed\", \"superseded\"] as const;",
].join("\n");
const CONDITIONS_UNPROTECTED = ["export const PROTECTED_PATHS = [", "  \"packages/authority/\",", "];"].join("\n");
const CONDITIONS_PROTECTED = ["export const PROTECTED_PATHS = [", "  \"packages/authority/\",", "  \".github/CODEOWNERS\",", "];"].join("\n");

const bothMerge = (target: Target) => ({ correctness: always(merges(target)), adversary: always(merges(target)) });
/** A seed head changes source with no test beside it, so the panel adds a tests seat. */
const panelMerges = (target: Target) => ({ ...bothMerge(target), tests: always(merges(target)) });
const correctnessBlocks = (finding: string) => (target: Target) => ({ ...panelMerges(target), correctness: always(fixFirst(target, finding)) });

/** TP-1929's seed: three heads a review should block, each at the path its defect lives in, and two fixed heads that pass. */
export const SEED_CASES: readonly EvalCase[] = [
  seedCase({
    id: "seed-tp747-empty-contexts", pr: 747, head: "1d9e6287f37eddc08c43936627975598290e7439", path: POLICY_PATH, source: POLICY_SOURCE,
    verdict: "block", outcome: "FIX_FIRST", members: correctnessBlocks(`An empty contexts list reads as a valid policy at ${POLICY_PATH}:3-4; it must read as unreadable.`),
  }),
  seedCase({
    id: "seed-tp754-ci-failed-abandon", pr: 754, head: "a60be9998c3fe04f8acfaf18252d1af820b5d4dd", path: EVIDENCE_PATH, source: EVIDENCE_SOURCE,
    verdict: "block", outcome: "FIX_FIRST", members: correctnessBlocks(`A ci-failed abandon takes its head from the run at ${EVIDENCE_PATH}:2, so it cannot pass the gate's schema.`),
  }),
  seedCase({
    id: "seed-tp755-codeowners-unprotected", pr: 755, head: "ea0bf5f48b9bb21f794f037e8af66df8bcdf1582", path: CONDITIONS_PATH, source: CONDITIONS_UNPROTECTED,
    verdict: "block", outcome: "FIX_FIRST", members: correctnessBlocks(`Dropping .github/ leaves .github/CODEOWNERS unprotected at ${CONDITIONS_PATH}:1-3.`),
  }),
  // A FIX_FIRST whose only citation is past the file's end: the verdict blocks, but nothing it cites is verified, so it is no catch.
  seedCase({
    id: "seed-tp755-fixed-merge-up", pr: 755, head: "84dc2b72f088845893d9e4cda8e4827a2f62131f", path: CONDITIONS_PATH, source: CONDITIONS_PROTECTED,
    verdict: "pass", outcome: "FIX_FIRST", members: correctnessBlocks(`The protected list still misses .github/ at ${CONDITIONS_PATH}:40.`),
  }),
  seedCase({
    id: "seed-tp755-codeowners-kept", pr: 755, head: "00ec6c058d3ce226682bf7c15d8f684d1f98ec9c", path: CONDITIONS_PATH, source: CONDITIONS_PROTECTED,
    verdict: "pass", outcome: "MERGE", members: panelMerges,
  }),
];

const synthHead = (digit: string): string => digit.repeat(40);

function proofLine(head: string, result: Pick<FixProofResult, "verdict" | "counts"> & Partial<FixProofResult>): string {
  return formatResultLine({ head, mergeBase: BASE, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, ...result });
}

const NO_COUNTS = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
const WIDGET_FILES = [{ path: "src/widget.ts", additions: 6, deletions: 2 }, { path: "src/widget.test.ts", additions: 12, deletions: 0 }];

interface FixtureFacts extends Omit<CaseFacts, "input" | "tags"> {
  digit: string;
  members: (target: Target) => Record<string, MemberScript>;
  input?: Partial<Omit<ReplayInput, "target" | "members">>;
}

function failureFixture({ digit, members, input, ...facts }: FixtureFacts): EvalCase {
  const target = { repo: SYNTHETIC_REPO, pr: 7, head: synthHead(digit) };
  const base: ReplayInput = {
    target, base: BASE, kind: "feature", authorityTouch: true, changedFiles: WIDGET_FILES, sources: {}, proof: { kind: "skipped" }, uninstalled: [], members: members(target),
  };
  return evalCase({ ...facts, tags: ["failure-fixture"], input: { ...base, ...input } });
}

const VACUOUS_PROVED = (head: string) =>
  proofLine(head, {
    verdict: "vacuous",
    counts: { ...NO_COUNTS, "passes-on-base": 1 },
    tests: [{ file: "src/widget.test.ts", name: "holds", class: "passes-on-base" }],
    mutants: { verdict: "killed", results: [{ spec: "src/widget.test.mutations.json", name: "drop the bound", outcome: "killed" }], uncovered: [] },
  });
const CARRIED_SPEC_ERROR = (head: string) =>
  proofLine(head, { verdict: "error", counts: NO_COUNTS, error: "mutation spec: mutation drop the bound: src/test-support/clock-rule.test.ts is a carried test-support file" });

/**
 * The failure-fixture suite (TP-3916 §2(d)): each case rebuilds one evidence run's shape from public PR facts or from nothing,
 * and replays it with fake ports and no model.
 */
export const FAILURE_FIXTURES: readonly EvalCase[] = [
  failureFixture({
    id: "fixture-tp1986-adversary-uninstalled", ref: "tp#1986", digit: "1", members: bothMerge,
    // The adversary's premium profile is missing, so the plan lowers it to its sonnet fallback, which is missing too.
    input: { uninstalled: ["fable-reviewer", "reviewer"] },
    expected: { outcome: "needs-fixer", fingerprint: "profile:reviewer", sessions: 0 },
  }),
  failureFixture({
    id: "fixture-tp2145-mutants-proved-vacuous", ref: "tp#2145", digit: "2", members: bothMerge, input: { proof: { kind: "result", line: VACUOUS_PROVED(synthHead("2")) } },
    expected: { outcome: "MERGE", sessions: 2 },
  }),
  failureFixture({
    id: "fixture-workflow-ci-unproved", digit: "3", members: bothMerge,
    input: { changedFiles: [{ path: ".github/workflows/ci.yml", additions: 2, deletions: 1 }], proof: { kind: "workflow-ci", proved: false, head: synthHead("3") } },
    expected: { outcome: "NO_REPRO", sessions: 0 },
  }),
  failureFixture({
    id: "fixture-tp2138-carried-test-support", ref: "tp#2138", digit: "4", members: panelMerges,
    input: { proof: { kind: "result", line: CARRIED_SPEC_ERROR(synthHead("4")) } },
    expected: { outcome: "MERGE", sessions: 3 },
  }),
  failureFixture({
    id: "fixture-synthetic-malformed-twice", digit: "5",
    members: (target) => ({ correctness: always(merges(target)), adversary: always({ say: "I read the diff and it looks fine." }) }),
    expected: { outcome: "needs-fixer", fingerprint: "parser:no_block", sessions: 2 },
  }),
  failureFixture({
    id: "fixture-synthetic-timeout", digit: "6", members: (target) => ({ correctness: always(merges(target)), adversary: {} }),
    expected: { outcome: "needs-fixer", fingerprint: "timeout:adversary", sessions: 3 },
  }),
  failureFixture({
    id: "fixture-synthetic-usage-limit", digit: "7", members: (target) => ({ correctness: always({ usageLimit: { resetsAt: 2_000_000 } }), adversary: always(merges(target)) }),
    expected: { outcome: "account-hold", sessions: 2 },
  }),
];
