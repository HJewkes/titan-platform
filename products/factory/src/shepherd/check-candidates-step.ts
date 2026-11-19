import type { PrFile } from "@titan-design/github";
import { CHECK_CANDIDATES_WARNINGS, CHECK_ROUTES, type ReviewTarget } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { CandidateInput } from "./check-candidates-store.js";
import { prFilesOf, registeredBase } from "./git-pr-files.js";
import type { ShepherdDeps } from "./phases.js";
import type { Awaited } from "./review-schemas.js";

type AwaitedResult = z.infer<typeof Awaited>;

export const CHECK_CANDIDATES_STEP = "sh-check-candidates";
export const CHECK_CANDIDATES_STEPS: readonly StepDeclaration[] = [{ id: CHECK_CANDIDATES_STEP, kind: "dispatch" }];

type CheckCandidatesMode = "off" | "record" | "propose";

export interface CheckCandidatesWiring {
  /** `shepherd.checkCandidates` as the config reads now; absent means `record`, the flag's default. */
  checkCandidatesMode?: () => CheckCandidatesMode;
}

/** The file list is only for the area, so a slow read records rows with no area rather than holding the verdict. */
const FILES_TIMEOUT_MS = 15_000;

const Candidate = z.object({ classKey: z.string(), route: z.enum(CHECK_ROUTES), sketch: z.string() });
const Warning = z.enum(CHECK_CANDIDATES_WARNINGS);
const Member = z.object({ shape: z.string(), agentId: z.string(), verdict: z.enum(["MERGE", "FIX_FIRST"]) });
const CandidatesInput = z.looseObject({
  runId: z.string(),
  repo: z.string(),
  pr: z.number(),
  head: z.string(),
  member: Member,
  checkCandidates: z.array(Candidate).optional(),
  checkCandidatesWarning: Warning.optional(),
});
type CandidatesInput = z.infer<typeof CandidatesInput>;
const CandidatesResult = z.looseObject({ recorded: z.number(), area: z.string().optional(), warning: z.string().optional(), skipped: z.string().optional(), error: z.string().optional() });
type CandidatesResult = z.infer<typeof CandidatesResult>;

const errorOf = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);

/** `packages/<x>` and `products/<x>` are an area each; any other path's area is its first segment. */
function areaOfPath(path: string): string {
  const [top = path, next] = path.split("/");
  return (top === "packages" || top === "products") && next !== undefined ? `${top}/${next}` : top;
}

/** The area with the most added and deleted lines; on a tie the one listed first keeps it. */
export function areaOf(files: readonly PrFile[]): string | undefined {
  const lines = new Map<string, number>();
  for (const file of files) {
    const area = areaOfPath(file.path);
    lines.set(area, (lines.get(area) ?? 0) + (file.additions ?? 0) + (file.deletions ?? 0));
  }
  let best: [string, number] | undefined;
  for (const entry of lines) if (best === undefined || entry[1] > best[1]) best = entry;
  return best?.[0];
}

function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms).unref()));
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

type FilesDeps = Pick<ShepherdDeps, "port" | "store" | "prFiles">;

/** No area when the list cannot be read in time: the rows still count toward their class. */
async function prAreaOf(deps: FilesDeps, input: CandidatesInput, timeoutMs: number): Promise<string | undefined> {
  try {
    const base = registeredBase(deps.store, input.runId);
    const target = { repo: input.repo as CandidateInput["repo"], pr: input.pr, head: input.head, ...(base !== undefined && { base }) };
    const files = await withinMs(prFilesOf(deps.port, target, deps.prFiles), timeoutMs);
    return files && areaOf(files);
  } catch {
    return undefined;
  }
}

function rowsOf(input: CandidatesInput, area: string | undefined): CandidateInput[] {
  const where = { runId: input.runId, repo: input.repo as CandidateInput["repo"], pr: input.pr, head: input.head, area: area ?? null, member: input.member };
  return (input.checkCandidates ?? []).map(({ classKey, route, sketch }) => ({ ...where, classKey, route, sketch, locator: `${input.repo}#${input.pr}@${input.head.slice(0, 12)}` }));
}

/** Never throws, and its result is read by nothing on the verdict path: a candidate is data and gates nothing. */
export async function checkCandidatesBody(deps: FilesDeps, mode: () => CheckCandidatesMode, input: CandidatesInput, timeoutMs = FILES_TIMEOUT_MS): Promise<CandidatesResult> {
  const warning = input.checkCandidatesWarning === undefined ? {} : { warning: input.checkCandidatesWarning };
  try {
    if (mode() === "off") return { recorded: 0, ...warning, skipped: "off" };
    if ((input.checkCandidates ?? []).length === 0) return { recorded: 0, ...warning };
    const area = await prAreaOf(deps, input, timeoutMs);
    const rows = rowsOf(input, area);
    deps.store.get().checkCandidates().record(rows);
    return { recorded: rows.length, ...(area !== undefined && { area }), ...warning };
  } catch (error) {
    return { recorded: 0, ...warning, error: errorOf(error) };
  }
}

/** The mode is read inside the body, never from the input, so flipping the flag mid-run cannot diverge a replay. */
export function checkCandidatesRoute(deps: FilesDeps & Pick<ShepherdDeps, "now">, wiring: CheckCandidatesWiring | undefined, timeoutMs?: number): StepRoute {
  const mode = wiring?.checkCandidatesMode ?? (() => "record" as const);
  return codeRoute(CHECK_CANDIDATES_STEP, deps.now, async (raw: unknown) => {
    const input = CandidatesInput.safeParse(raw);
    return input.success ? checkCandidatesBody(deps, mode, input.data, timeoutMs) : { recorded: 0, error: "unreadable sh-check-candidates input" };
  });
}

function candidatesOf(awaited: AwaitedResult): Pick<CandidatesInput, "checkCandidates" | "checkCandidatesWarning"> {
  const items = z.array(Candidate).safeParse(awaited.checkCandidates);
  const warning = Warning.safeParse(awaited.checkCandidatesWarning);
  return { ...(items.success && items.data.length > 0 && { checkCandidates: items.data }), ...(warning.success && { checkCandidatesWarning: warning.data }) };
}

/**
 * Records a verdict's Check-candidates, MERGE or FIX_FIRST, after its follow-ups are filed; a verdict with neither field
 * records nothing. A run whose record continues past this point without the step took its verdict before the step existed,
 * so its replay skips it.
 */
export async function recordCheckCandidatesAt(ctx: WorkflowContext, target: ReviewTarget, awaited: AwaitedResult, suffix = "", shape = "correctness"): Promise<void> {
  if (awaited.kind !== "verdict") return;
  const found = candidatesOf(awaited);
  if (found.checkCandidates === undefined && found.checkCandidatesWarning === undefined) return;
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(CHECK_CANDIDATES_STEP, next)) return;
  const member = { shape, agentId: awaited.reviewer.agentId, verdict: awaited.verdict };
  const input = { runId: ctx.runId, repo: target.repo, pr: target.pr, head: target.head, member, ...found };
  await step(ctx, `${CHECK_CANDIDATES_STEP}:${target.head}${suffix}`, input, CandidatesResult);
}
