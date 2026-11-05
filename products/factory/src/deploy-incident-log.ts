import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DeployIncident } from "./deploy-incident.js";

const DEPLOY_INCIDENTS = "deploy-incidents.jsonl";

const DeployIncidentSchema = z.object({
  kind: z.enum(["rolled-back", "rollback-failed"]),
  target: z.string(),
  from: z.string(),
  why: z.string(),
  at: z.string(),
});

interface LogPorts {
  exists: (path: string) => boolean;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
}

export const deployIncidentLogPath = (stateDir: string): string => join(stateDir, DEPLOY_INCIDENTS);

const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The log's presence is what tells a reader that recording is live, so an empty log reads as zero incidents, not unknown. */
export function ensureDeployIncidentLog(ports: LogPorts, stateDir: string): string | undefined {
  const path = deployIncidentLogPath(stateDir);
  try {
    if (!ports.exists(path)) ports.writeFile(path, "");
    return undefined;
  } catch (error) {
    return failureOf(error);
  }
}

/** Read, add a line, write back: safe only under the deploy lock, which serializes every writer. */
export function recordDeployIncident(ports: LogPorts, stateDir: string, incident: DeployIncident): string | undefined {
  const path = deployIncidentLogPath(stateDir);
  try {
    const text = ports.readFile(path) ?? "";
    const lead = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    ports.writeFile(path, `${lead}${JSON.stringify(incident)}\n`);
    return undefined;
  } catch (error) {
    return failureOf(error);
  }
}

function parseLine(line: string): DeployIncident | undefined {
  try {
    const parsed = DeployIncidentSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A torn or malformed line is skipped, so one bad write never hides the incidents around it. */
export function parseDeployIncidents(text: string): DeployIncident[] {
  return text.split("\n").flatMap((line) => {
    const incident = line.trim() === "" ? undefined : parseLine(line);
    return incident === undefined ? [] : [incident];
  });
}

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Undefined when the log cannot be read, which the audit reports as unknown; an empty log is no incidents. */
export function readDeployIncidents(stateDir: string, read: (path: string) => string | undefined = readIfPresent): DeployIncident[] | undefined {
  const text = read(deployIncidentLogPath(stateDir));
  return text === undefined ? undefined : parseDeployIncidents(text);
}
