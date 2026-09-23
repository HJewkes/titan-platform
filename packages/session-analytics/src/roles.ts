import type { SessionClassification } from "./classify-session.js";

/** worker-v1's role vocabulary, from worker-forensics-report.md section 2. */
export type WorkerRole = "implementer" | "reviewer" | "researcher" | "planner" | "standing_peer" | "unknown";

/** Spawn profile to role, as the worker report's table (wf_analyze.py:79-91) maps it. */
export const PROFILE_ROLES: Readonly<Record<string, WorkerRole>> = {
  implementer: "implementer",
  "implementer-lite": "implementer",
  "relay-implementer": "implementer",
  "beat-builder": "implementer",
  "fable-optimizer": "implementer",
  reviewer: "reviewer",
  "relay-reviewer": "reviewer",
  researcher: "researcher",
  explorer: "researcher",
  "fable-architect": "planner",
  peer: "standing_peer",
};

export const STANDING_PEER_MIN_HOURS = 12;
export const STANDING_PEER_MIN_ASSIGNMENTS = 2;
const HOUR_MS = 3_600_000;

export interface WorkerFacts {
  profile?: string | null;
  /** First request to last request, over the whole session rather than a report window. */
  lifetimeMs: number;
  /** worker-v1 episodes opened by an assignment (the brief or a channel follow-up), not by an idle gap. */
  assignments: number;
}

export function roleFromProfile(profile: string | null | undefined): WorkerRole {
  return PROFILE_ROLES[(profile ?? "").toLowerCase()] ?? "unknown";
}

/** A worker that outlives its first assignment is a standing peer whatever it was spawned as (wf_analyze.py:94-103). */
export function workerRole(facts: WorkerFacts): WorkerRole {
  const outlived = facts.lifetimeMs >= STANDING_PEER_MIN_HOURS * HOUR_MS && facts.assignments >= STANDING_PEER_MIN_ASSIGNMENTS;
  return outlived ? "standing_peer" : roleFromProfile(facts.profile);
}

/** The report's role key: `coordinator` or `adhoc` for humans, `worker:<role>` for spawned agents, else the class. */
export function sessionRole(classification: SessionClassification, worker: WorkerFacts): string {
  if (classification.humanRole) return classification.humanRole;
  if (classification.sessionClass === "agent_spawned") return `worker:${workerRole(worker)}`;
  return classification.sessionClass;
}
