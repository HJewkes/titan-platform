import type { DeployIncident } from "./deploy-incident.js";
import type { ServiceIo } from "./service-control.js";

/** The owner-queue side of a deploy: the rollback incident notice and the withdraw of alarms a good deploy resolves. */
export interface NoticePorts {
  /** Tells the hub seat and the owner queue about a rollback that paused deploys; absent means only stderr carries it. */
  incident?: (incident: DeployIncident) => Promise<void>;
  /** Withdraws the open deploy alarms and incidents as resolved, returning how many; absent means they stay for a person. */
  resolveAlarms?: () => Promise<number>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function announce(ports: NoticePorts, io: ServiceIo, incident: DeployIncident): Promise<void> {
  if (!ports.incident) return io.stderr("error: no incident notice is wired, so only this log carries the rollback\n");
  try {
    await ports.incident(incident);
  } catch (error) {
    io.stderr(`error: the incident notice failed: ${message(error)}\n`);
  }
}

/** Only after a deploy whose build answered and held through the watch; a failure is reported and never fails the deploy. */
export async function resolveAlarms(ports: NoticePorts, io: ServiceIo): Promise<void> {
  if (!ports.resolveAlarms) return;
  try {
    const withdrawn = await ports.resolveAlarms();
    if (withdrawn > 0) io.stdout(`withdrew ${withdrawn} resolved deploy alarm(s) from the owner inbox\n`);
  } catch (error) {
    io.stderr(`error: could not withdraw resolved deploy alarms: ${message(error)}\n`);
  }
}
