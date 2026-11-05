import { runningHolds, type AncestryProbe } from "../build-ancestry.js";
import type { AuditIncident, IncidentLinks } from "./audit-facts.js";

/** The first rollout to bring `merge` in: its target holds it and the build it replaced did not; an unknown `from` holds nothing, so it over-counts. */
async function bringsIn(probe: AncestryProbe, incident: AuditIncident, merge: string): Promise<boolean | "unknown"> {
  const holds = await runningHolds(probe, incident.target, merge);
  if (typeof holds === "object") return "unknown";
  if (!holds) return false;
  const held = await runningHolds(probe, incident.from, merge);
  return typeof held === "object" ? "unknown" : !held;
}

async function linkedTo(incidents: readonly AuditIncident[], merge: string, probe: AncestryProbe): Promise<AuditIncident[] | "unknown"> {
  const linked: AuditIncident[] = [];
  for (const incident of incidents) {
    const answer = await bringsIn(probe, incident, merge);
    if (answer === "unknown") return "unknown";
    if (answer) linked.push(incident);
  }
  return linked;
}

/** One ancestry pass over every incident for each merge; an unreadable answer is never read as no incident. */
export async function linkIncidents(incidents: readonly AuditIncident[], mergeShas: readonly string[], probe: AncestryProbe): Promise<IncidentLinks> {
  const links = new Map<string, AuditIncident[] | "unknown">();
  for (const merge of new Set(mergeShas)) links.set(merge, await linkedTo(incidents, merge, probe));
  return links;
}
