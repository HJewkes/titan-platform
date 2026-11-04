import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { followUpSignals, transcriptSignals, type AgentLog, type WorkerSessionRecord } from "@titan-design/session-analytics";

/** Each Claude profile keeps its transcripts at `<profile>/projects/<project>/<session id>.jsonl`. */
export const defaultProfilesRoot = () => path.join(os.homedir(), ".claude-profiles");

const subdirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));

/** Transcripts written to since `sinceMs`, by session id; an older file cannot hold a line in the window. */
export function recentTranscripts(profilesRoot: string, sinceMs: number): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (!existsSync(profilesRoot)) return found;
  for (const profile of subdirs(profilesRoot)) {
    const projects = path.join(profile, "projects");
    if (!existsSync(projects)) continue;
    for (const project of subdirs(projects)) {
      for (const name of readdirSync(project).filter((n) => n.endsWith(".jsonl"))) {
        const file = path.join(project, name);
        if (statSync(file).mtimeMs < sinceMs) continue;
        const sessionId = name.slice(0, -".jsonl".length);
        found.set(sessionId, [...(found.get(sessionId) ?? []), file]);
      }
    }
  }
  return found;
}

const USER_RECORD = /"type":\s*"user"/;

/** Only tool lines and prompts, read as a stream: a long-lived seat's transcript can run to hundreds of megabytes. */
async function toolLines(file: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (line.includes('"tool_use"') || line.includes('"tool_result"') || USER_RECORD.test(line)) lines.push(line);
  }
  return lines;
}

interface AgentLogInput {
  sessions: readonly WorkerSessionRecord[];
  transcripts: ReadonlyMap<string, readonly string[]>;
  followUps: readonly { agent: string; at: string; body: string }[];
  window: { since: string; until: string };
}

/** One log per agent with a transcript in the window, plus its spawner's follow-ups to it. */
export async function readAgentLogs(input: AgentLogInput): Promise<AgentLog[]> {
  const logs = new Map<string, AgentLog>();
  for (const { agent, sessionId } of input.sessions) {
    const files = input.transcripts.get(sessionId) ?? [];
    if (files.length === 0) continue;
    const log = logs.get(agent) ?? { agent, sessions: [], signals: [] };
    for (const file of files) log.signals.push(...transcriptSignals(await toolLines(file), input.window));
    log.sessions.push(sessionId);
    logs.set(agent, log);
  }
  for (const log of logs.values()) log.signals.push(...followUpSignals(input.followUps.filter((f) => f.agent === log.agent)));
  return [...logs.values()];
}
