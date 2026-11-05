import { createHash } from "node:crypto";
import { dataFence } from "@titan-design/agent-dispatch";
import type { ReviewTarget } from "@titan-design/review-panel";
import { FIXER_FIXES, FIXER_REPORT_END, FIXER_REPORT_START } from "./fixer-report.js";
import type { FixerPort } from "./ports.js";
import type { FixerKey } from "./retry-policy.js";
import type { FailureClass, ReviewOutcome } from "./types.js";

/** The newest log lines naming a failed member that the brief quotes. */
const MAX_LOG_LINES = 40;

/** One hard error: the policy row's fixer key plus the class's own detail (a profile name, a shape, a step id). */
export interface FixerCase {
  failure: FailureClass;
  key: FixerKey;
  detail?: readonly string[];
}

/** `<key>:<detail>…`, for example `profile:reviewer`; whitespace inside a detail becomes `-`, so it stays one argv word. */
export function fixerFingerprint(fixerCase: FixerCase): string {
  const detail = (fixerCase.detail ?? []).map((part) => part.trim().replace(/\s+/g, "-")).filter((part) => part !== "");
  return [fixerCase.key, ...detail].join(":");
}

/**
 * A pure function of the fingerprint and how often it was resolved, never of the PR, so a second run with the same
 * fingerprint finds the first fixer's roster row. A run that fails again after a resolve gets a fresh fixer.
 */
export function fixerName(fingerprint: string, round = 0): string {
  const base = `wf-fix-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 8)}`;
  return round === 0 ? base : `${base}-r${round + 1}`;
}

/** One review run waiting on a fingerprint's fix. */
export interface ParkedRun {
  runId: string;
  target: ReviewTarget;
  fingerprint: string;
  failure: FailureClass;
}

/** Where parked runs wait; the host stores them, so a parked run outlives the process that parked it. */
export interface ParkingPort {
  /** Idempotent per `runId`. */
  park(run: ParkedRun): Promise<void>;
  parked(fingerprint: string): Promise<readonly ParkedRun[]>;
  /** Clears every run parked on the fingerprint, advances its round, and returns the runs it cleared. */
  release(fingerprint: string): Promise<readonly ParkedRun[]>;
  /** How many times the fingerprint was released; 0 before its first resolve. */
  round(fingerprint: string): Promise<number>;
}

/**
 * What the fixer may do. Only `propose` exists: it files a task or writes a patch into its report, and the coordinator
 * applies it. An apply mode is a new key here plus its rules (owner question TP-3916 Q1).
 */
export type FixerMode = "propose";

const NEVER = "Do not review, push to or merge any PR, and do not start a reviewer.";
const FIXER_MODE_RULES: Record<FixerMode, readonly string[]> = {
  propose: [
    "Read the recorded steps, the member transcripts and the log lines, and work out the one root cause behind this fingerprint.",
    NEVER,
    "Change nothing: no config, profile, tool grant, permission field, hook, settings file, seat file or code. Propose the fix instead.",
    "For a config or profile-field fix, write the proposed change in Patch. For a code defect, file a task and name it in Task.",
  ],
};

export interface FixerMember {
  name: string;
  agentId?: string;
  sessionId?: string;
  transcriptPath?: string;
  /** Why the member never started, when its dispatch was refused. */
  refused?: string;
}

/** What the failed attempts left behind; every field is quoted to the fixer as data. */
export interface FixerEvidence {
  /** The recorded steps of the failed attempts, one `stepId: summary` line each. */
  steps: readonly string[];
  members: readonly FixerMember[];
  /** The tail of the host's error log; only lines naming a member are quoted. */
  log?: string;
}

export interface FixerRequest {
  runId: string;
  target: ReviewTarget;
  fixerCase: FixerCase;
  evidence: FixerEvidence;
  /** The seat the fixer reports to; absent means its spawner. */
  reportTo?: string;
  mode?: FixerMode;
}

/** The record a run keeps under its fixer step: `spawned` is false when the fingerprint's fixer already existed or was refused. */
export interface FixerRecord {
  fingerprint: string;
  agent: string;
  spawned: boolean;
  reason?: string;
}

function memberLine(member: FixerMember): string {
  if (member.sessionId === undefined) return `- ${member.name}: never started (${member.refused ?? "no dispatch was recorded"})`;
  return `- ${member.name}: session ${member.sessionId}, transcript ${member.transcriptPath ?? "not on the roster"}`;
}

/** The newest lines that name a member by name, agent id or session id. */
function matchingLogLines(log: string | undefined, members: readonly FixerMember[]): string[] {
  const keys = members.flatMap((member) => [member.name, member.agentId, member.sessionId]).filter((key): key is string => key !== undefined && key !== "");
  if (log === undefined || keys.length === 0) return [];
  return log.split("\n").filter((line) => keys.some((key) => line.includes(key))).slice(-MAX_LOG_LINES);
}

function reportFormat(fingerprint: string, failure: FailureClass): string[] {
  return [
    "End your final message with this block, one field per line:",
    FIXER_REPORT_START,
    `Fingerprint: ${fingerprint}`,
    `Class: ${failure}`,
    "Root-cause: <one line>",
    "Evidence: <path:line or a quoted log line; repeat the field for each>",
    `Fix: ${FIXER_FIXES.join("|")}`,
    "Patch: <the proposed change, only for config or profile-field>",
    "Task: <the filed task id, only for code-task>",
    "Resolves: yes|no",
    FIXER_REPORT_END,
  ];
}

function evidenceLines(evidence: FixerEvidence): string[] {
  const logLines = matchingLogLines(evidence.log, evidence.members);
  return [
    evidence.steps.length > 0 ? dataFence("recorded steps", evidence.steps.join("\n")) : "Recorded steps: none.",
    "",
    "Members:",
    ...(evidence.members.length > 0 ? evidence.members.map(memberLine) : ["- none recorded"]),
    "",
    logLines.length > 0 ? dataFence("log lines naming these members oldest first", logLines.join("\n")) : "Log: no line names these members.",
  ];
}

/** Generalizes Shepherd's no-verdict diagnosis brief from one PR to every run parked on one fingerprint. */
export function fixerBrief(request: FixerRequest, fingerprint: string, parked: readonly ParkedRun[]): string {
  const rules = FIXER_MODE_RULES[request.mode ?? "propose"];
  return [
    `Review workflow runs stopped on a hard error with fingerprint ${fingerprint}. Find its root cause once for every run parked on it, instead of another blind review or an owner gate.`,
    "",
    ...[`Fingerprint: ${fingerprint}`, `Class: ${request.fixerCase.failure}`, "Parked runs:"],
    ...parked.map((run) => `- ${run.target.repo}#${run.target.pr} at ${run.target.head} (run ${run.runId})`),
    "",
    ...evidenceLines(request.evidence),
    "",
    ...rules.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...reportFormat(fingerprint, request.fixerCase.failure),
    ...(request.reportTo === undefined ? [] : [`Send the report to ${request.reportTo} with chat_send.`]),
  ].join("\n");
}

async function spawnOnce(fixer: FixerPort, agent: string, brief: () => string): Promise<Pick<FixerRecord, "spawned" | "reason">> {
  try {
    if ((await fixer.roster()).some((row) => row.name === agent)) return { spawned: false, reason: "the fingerprint's fixer is already on the roster" };
    await fixer.spawn(agent, brief());
    return { spawned: true };
  } catch (error) {
    return { spawned: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Parks the run on its fingerprint and spawns that fingerprint's fixer unless the roster already holds it. A refused
 * spawn is recorded, not thrown: the run stays parked and the record's `reason` tells the host.
 */
export async function requestFixer(
  ports: { fixer: FixerPort; parking: ParkingPort },
  request: FixerRequest,
): Promise<{ record: FixerRecord; outcome: ReviewOutcome }> {
  const fingerprint = fixerFingerprint(request.fixerCase);
  const { failure } = request.fixerCase;
  await ports.parking.park({ runId: request.runId, target: request.target, fingerprint, failure });
  const agent = fixerName(fingerprint, await ports.parking.round(fingerprint));
  const parked = await ports.parking.parked(fingerprint);
  const spawn = await spawnOnce(ports.fixer, agent, () => fixerBrief(request, fingerprint, parked));
  return { record: { fingerprint, agent, ...spawn }, outcome: { kind: "needs-fixer", head: request.target.head, fingerprint, failure } };
}

export type Resumed = { run: ParkedRun; outcome: ReviewOutcome } | { run: ParkedRun; error: string };

/**
 * Re-runs every run parked on the fingerprint, one at a time, once the coordinator has applied the fix. A resume that
 * throws parks its run again, so no run is lost; a run that fails on the same cause parks itself with a fresh fixer.
 */
export async function resolveFingerprint(
  parking: ParkingPort,
  fingerprint: string,
  resume: (run: ParkedRun) => Promise<ReviewOutcome>,
): Promise<Resumed[]> {
  const results: Resumed[] = [];
  for (const run of await parking.release(fingerprint)) {
    try {
      results.push({ run, outcome: await resume(run) });
    } catch (error) {
      await parking.park(run);
      results.push({ run, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
