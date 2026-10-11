import type { OwnerItemDeposit } from "@titan-design/owner-queue";

/** A rollback of a restarted build: `rollback-failed` means the old build was not seen serving, so the service may be down. */
export interface DeployIncident {
  kind: "rolled-back" | "rollback-failed";
  target: string;
  from: string;
  why: string;
  at: string;
}

const CLEAR_COMMAND = "titan-factory service pause --clear";
const SUMMARY_MAX = 280;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function incidentMessage(incident: DeployIncident): string {
  const lead =
    incident.kind === "rollback-failed"
      ? `ALERT: titan-factory deploy of ${incident.target} failed and the rollback to ${incident.from} did not verify; the service may be down.`
      : `titan-factory deploy of ${incident.target} failed its health watch and rolled back to ${incident.from}.`;
  return `${lead} Why: ${oneLine(incident.why, 600)}. Every Shepherd deploy is paused until someone runs ${CLEAR_COMMAND}.`;
}

/** Keyed on the target, so a second notice for the same rollback files no second item. */
export function incidentDeposit(incident: DeployIncident): OwnerItemDeposit {
  const failed = incident.kind === "rollback-failed";
  return {
    depositId: `deploy-incident-${incident.target}`,
    asker: "titan-factory",
    kind: "do",
    door: "two-way",
    summary: oneLine(`${failed ? "ROLLBACK FAILED: " : ""}titan-factory deploy of ${incident.target} rolled back; deploys paused`, SUMMARY_MAX),
    context: incidentMessage(incident),
    command: CLEAR_COMMAND,
    keys: ["deploy-incident"],
  };
}
