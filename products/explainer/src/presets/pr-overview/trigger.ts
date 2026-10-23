import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { prDiag } from "./diagnostics.js";
import { gatherPr, writeGather, type GatherPrOptions } from "./gather.js";
import type { PrRef } from "./pr-read.js";

/** Shepherd's hold class for a PR waiting on the owner's Gate 2 visual sign-off. */
export const VISUAL_GATE_CLASS = "visual-gate2";
export const DECISION_BRIEF_CUT = "decision-brief";

/** The fields of one `titan-factory shepherd waiting --json` gate the trigger reads; the rest pass through unread. */
const WaitingGateSchema = z.looseObject({
  gateId: z.string(),
  repo: z.string(),
  pr: z.number().int().nullable(),
  head: z.string().nullable(),
  headIsCurrent: z.boolean().nullable(),
  held: z.string().nullable(),
});
export const WaitingSchema = z.looseObject({ owner: z.array(WaitingGateSchema), seat: z.array(WaitingGateSchema) });
export type Waiting = z.infer<typeof WaitingSchema>;

export interface BriefTarget extends PrRef {
  head: string;
  gateId: string;
}

/** Read the way Shepherd's own `holdClassOf` reads a hold reason: the text before the first ":". */
const holdClass = (reason: string | null): string | undefined => (reason?.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

/**
 * The PRs that get a decision brief without being asked (owner answer Q6): owner gates held at the visual gate,
 * on a head the gate still names. Seat gates and every other owner gate are on request only.
 */
export function autoBriefTargets(waiting: Waiting): BriefTarget[] {
  const targets = new Map<string, BriefTarget>();
  for (const gate of waiting.owner) {
    if (gate.pr === null || gate.head === null || gate.headIsCurrent === false || holdClass(gate.held) !== VISUAL_GATE_CLASS) continue;
    targets.set(`${gate.repo}#${gate.pr}`, { repo: gate.repo, number: gate.pr, head: gate.head, gateId: gate.gateId });
  }
  return [...targets.values()];
}

/** One brief directory per PR head, so a new head gets a new brief and a re-run sweep starts nothing twice. */
export const briefDir = (dataDir: string, target: BriefTarget): string =>
  join(dataDir, "pr-briefs", `${target.repo.replace("/", "--")}--${target.number}--${target.head.slice(0, 12)}`);

const execFileAsync = promisify(execFile);
const OverdueExit = z.looseObject({ code: z.literal(1), stdout: z.string().trim().min(1) });

/** `shepherd waiting` exits 1 when an owner gate is overdue and still prints the list, so stdout is read either way. */
export async function shepherdWaiting(port?: number): Promise<unknown> {
  const args = ["shepherd", "waiting", "--json", ...(port === undefined ? [] : ["--port", String(port)])];
  try {
    return JSON.parse((await execFileAsync("titan-factory", args)).stdout);
  } catch (error) {
    const overdue = OverdueExit.safeParse(error);
    if (overdue.success) return JSON.parse(overdue.data.stdout);
    throw error;
  }
}

/** Starts a decision-brief run for one PR: its gather stage, written to `dir`. */
export type StartBrief = (target: BriefTarget, dir: string) => Promise<"started" | "refused">;

export interface TriggerOptions {
  dataDir: string;
  readWaiting: () => Promise<unknown>;
  start: StartBrief;
  dryRun?: boolean;
}

export interface TriggerRow {
  pr: string;
  head: string;
  outcome: "would-start" | "started" | "refused" | "already";
  dir: string;
}

/** One sweep: reads the waiting gates, picks the visual-gate PRs, and starts a brief for each head not yet briefed. */
export async function runPrVideoTrigger(options: TriggerOptions): Promise<TriggerRow[]> {
  const targets = autoBriefTargets(WaitingSchema.parse(await options.readWaiting()));
  const rows: TriggerRow[] = [];
  for (const target of targets) {
    const dir = briefDir(options.dataDir, target);
    const row = { pr: `${target.repo}#${target.number}`, head: target.head, dir };
    if (existsSync(join(dir, "brief.json"))) rows.push({ ...row, outcome: "already" });
    else if (options.dryRun) rows.push({ ...row, outcome: "would-start" });
    else rows.push({ ...row, outcome: await options.start(target, dir) });
  }
  return rows;
}

/** The production start: writes `brief.json` first, so a failed gather is not retried on the same head, then gathers. */
export function gatherStart(cloneFor: (repo: string) => string | undefined, deps: Pick<GatherPrOptions, "gh" | "callEdges"> = {}): StartBrief {
  return async (target, dir) => {
    const pr = `${target.repo}#${target.number}`;
    const clonePath = cloneFor(target.repo);
    await mkdir(dir, { recursive: true });
    const brief = { schema: "explainer.pr-brief/v1", profile: "pr-overview", cut: DECISION_BRIEF_CUT, trigger: VISUAL_GATE_CLASS, pr, head: target.head, gateId: target.gateId };
    await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
    const result = clonePath === undefined
      ? { ok: false as const, diagnostics: [prDiag("E-NO-CLONE", `no clone is configured for ${target.repo}`)] }
      : await gatherPr({ pr, clonePath, ...deps });
    await writeGather(dir, result);
    return result.ok ? "started" : "refused";
  };
}
