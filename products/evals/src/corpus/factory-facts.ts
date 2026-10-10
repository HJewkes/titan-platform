import { z } from "zod";
import type { FactoryReader, FactoryRegistration, FactoryRun, OwnerGateRow } from "./factory-db.js";
import {
  LandedSchema,
  MainCiSchema,
  MainRedSchema,
  OwnerGatePayloadSchema,
  ResolverSchema,
  ReviewDispatchSchema,
  RunParamsSchema,
  VerdictResultSchema,
  readStep,
  stepFamily,
  type VerdictResult,
} from "./step-record.js";

export interface HeadVerdict {
  repo: string;
  pr: number;
  runId: string;
  verdictAt: string;
  /** `late` when the verdict arrived after Shepherd stopped waiting; recent runs record most verdicts there. */
  step: "await" | "late";
  dispatchedAt: number | undefined;
  result: VerdictResult;
}

export interface Landing {
  headSha: string;
  mergeSha: string;
}

export interface OwnerDecision {
  decision: string;
  reason: string | null;
}

export interface FactoryFacts {
  /** One per (repo, pr, head): the latest verdict recorded at that head across every run, iteration and replay. */
  verdicts: HeadVerdict[];
  landings: Map<string, Landing>;
  /** Merge shas whose post-merge read was red, or that raised a `main-red` gate. */
  redMerges: Set<string>;
  /** Owner-resolved `approve-merge` decisions, by head sha. */
  ownerDecisions: Map<string, OwnerDecision>;
  registrations: Map<string, FactoryRegistration>;
}

export const prKey = (repo: string, pr: number): string => `${repo.toLowerCase()}#${pr}`;
const headKey = (repo: string, pr: number, head: string): string => `${prKey(repo, pr)}@${head}`;

interface RunScan {
  verdicts: HeadVerdict[];
  /** Review dispatch times per head, epoch ms; a head re-dispatched after a verdict has several. */
  dispatches: Map<string, number[]>;
  landing: Landing | undefined;
  red: string[];
}

type RunBase = Pick<HeadVerdict, "repo" | "pr" | "runId">;
type StepReader = (scan: RunScan, result: unknown, completedAt: string | undefined, base: RunBase) => void;

const verdictReader =
  (step: HeadVerdict["step"]): StepReader =>
  (scan, result, completedAt, base) => {
    const verdict = VerdictResultSchema.safeParse(result);
    if (verdict.success && completedAt) scan.verdicts.push({ ...base, step, verdictAt: completedAt, dispatchedAt: undefined, result: verdict.data });
  };

const STEP_READERS: Record<string, StepReader> = {
  "sh-await-verdict": verdictReader("await"),
  "sh-late-verdict": verdictReader("late"),
  "sh-review": (scan, result) => {
    const dispatch = ReviewDispatchSchema.safeParse(result);
    const at = dispatch.success ? (dispatch.data.startedAt ?? dispatch.data.at) : undefined;
    if (dispatch.success && at !== undefined) scan.dispatches.set(dispatch.data.head, [...(scan.dispatches.get(dispatch.data.head) ?? []), at]);
  },
  "sh-landed": (scan, result) => {
    const landed = LandedSchema.safeParse(result);
    if (landed.success) scan.landing = { headSha: landed.data.headSha, mergeSha: landed.data.mergeSha };
  },
  "sh-main-ci": (scan, result) => {
    const ci = MainCiSchema.safeParse(result);
    if (ci.success && ci.data.verdict === "red") scan.red.push(ci.data.mergeSha);
  },
  "main-red": (scan, result) => {
    const red = MainRedSchema.safeParse(result);
    if (red.success) scan.red.push(red.data.mergeSha);
  },
};

function parseJson(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

const StepResultsSchema = z.record(z.string(), z.unknown());

/** The dispatch this verdict answered: the last one at or before it. */
function dispatchFor(dispatches: readonly number[] | undefined, verdictAt: string): number | undefined {
  const at = Date.parse(verdictAt);
  const before = (dispatches ?? []).filter((dispatch) => dispatch <= at);
  return before.length > 0 ? Math.max(...before) : undefined;
}

function scanRun(run: FactoryRun): (RunScan & { repo: string; pr: number }) | undefined {
  const params = RunParamsSchema.safeParse(parseJson(run.params));
  const steps = StepResultsSchema.safeParse(parseJson(run.stepResults));
  if (!params.success || !Number.isInteger(params.data.pr) || !steps.success) return undefined;
  const { repo, pr } = params.data;
  const scan: RunScan = { verdicts: [], dispatches: new Map(), landing: undefined, red: [] };
  for (const [key, entry] of Object.entries(steps.data)) {
    const step = readStep(entry);
    if (step) STEP_READERS[stepFamily(key)]?.(scan, step.result, step.completedAt, { repo, pr, runId: run.id });
  }
  for (const verdict of scan.verdicts) verdict.dispatchedAt = dispatchFor(scan.dispatches.get(verdict.result.head), verdict.verdictAt);
  return { ...scan, repo, pr };
}

/** Registrations and runs spell one repo with different cases; rows carry the spelling most runs used. */
function canonicalRepos(scans: readonly { repo: string }[]): (repo: string) => string {
  const counts = new Map<string, Map<string, number>>();
  for (const { repo } of scans) {
    const spellings = counts.get(repo.toLowerCase()) ?? new Map<string, number>();
    counts.set(repo.toLowerCase(), spellings.set(repo, (spellings.get(repo) ?? 0) + 1));
  }
  const canonical = new Map([...counts].map(([key, spellings]) => [key, [...spellings].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key]));
  return (repo) => canonical.get(repo.toLowerCase()) ?? repo;
}

function latestPerHead(verdicts: readonly HeadVerdict[]): HeadVerdict[] {
  const byHead = new Map<string, HeadVerdict>();
  for (const verdict of verdicts) {
    const key = headKey(verdict.repo, verdict.pr, verdict.result.head);
    const seen = byHead.get(key);
    if (!seen || seen.verdictAt < verdict.verdictAt) byHead.set(key, verdict);
  }
  return [...byHead.values()].sort((a, b) => a.verdictAt.localeCompare(b.verdictAt));
}

function ownerDecision(gate: OwnerGateRow): [string, OwnerDecision] | undefined {
  const resolver = ResolverSchema.safeParse(parseJson(gate.resolvedBy));
  const payload = OwnerGatePayloadSchema.safeParse(parseJson(gate.payload));
  if (!resolver.success || resolver.data.class !== "owner-terminal" || !payload.success) return undefined;
  return [payload.data.headSha, { decision: payload.data.decision, reason: gate.reason }];
}

const mapEntry = <T>(entry: [string, T] | undefined): [string, T][] => (entry ? [entry] : []);

export function readFactoryFacts(reader: FactoryReader): FactoryFacts {
  const scanned = reader.runs().flatMap((run) => scanRun(run) ?? []);
  const repoOf = canonicalRepos(scanned);
  const scans = scanned.map((scan) => ({ ...scan, repo: repoOf(scan.repo), verdicts: scan.verdicts.map((verdict) => ({ ...verdict, repo: repoOf(verdict.repo) })) }));
  const landings = new Map<string, Landing>();
  for (const scan of scans) if (scan.landing) landings.set(prKey(scan.repo, scan.pr), scan.landing);
  return {
    verdicts: latestPerHead(scans.flatMap((scan) => scan.verdicts)),
    landings,
    redMerges: new Set(scans.flatMap((scan) => scan.red)),
    ownerDecisions: new Map(reader.approveMergeGates().flatMap((gate) => mapEntry(ownerDecision(gate)))),
    registrations: new Map(reader.registrations().map((registration) => [registration.runId, registration])),
  };
}
