import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { GateResolver } from "@titan-design/hitl";
import type { FactoryHost } from "./host.js";

/** The CLI's own exit codes, repeated here because cli.ts imports this module. */
const EXIT = { OK: 0, USAGE: 2 } as const;

interface ResolveIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

/** `titan-factory gate resolve`: answers the gate the run waits on at `stepId`; a resolver refusal throws to the CLI, which exits 1. */
export function resolveGate(host: FactoryHost, io: ResolveIo, runId: string, stepId: string, json: string): number {
  const payload = parsePayload(json);
  if (!payload) {
    io.stderr("error: --json must be a JSON object\n");
    return EXIT.USAGE;
  }
  const repeated = repeatedResolution(host, runId, stepId, payload);
  if (repeated !== undefined) {
    io.stdout(`already resolved ${repeated} with this answer\n`);
    return EXIT.OK;
  }
  host.runtime.signal(runId, stepId, payload, cliResolver(io.env));
  io.stdout(`resolved ${runId}/${stepId}\n`);
  return EXIT.OK;
}

/** The gate a repeat of this resolve already answered: none for the step is pending, and its latest gate holds this payload. */
function repeatedResolution(host: FactoryHost, runId: string, stepId: string, payload: Record<string, unknown>): string | undefined {
  const base = `${runId}/${stepId}`;
  if (host.pendingGates().some(({ gate }) => gate.id === base || gate.id.startsWith(`${base}:`))) return undefined;
  let latest = host.gates.get(base);
  for (let n = 1; ; n += 1) {
    const next = host.gates.get(`${base}:${n}`);
    if (next === undefined) break;
    latest = next;
  }
  return latest?.status === "resolved" && isDeepStrictEqual(latest.payload, payload) ? latest.id : undefined;
}

/** Owner unless agent-chat spawned this shell; CLAUDECODE is ignored because the owner's `!` commands set it too. A refusal exits FAILURE through `parse`. */
function cliResolver(env: NodeJS.ProcessEnv): GateResolver {
  return { class: env.AGENT_CHAT_AGENT_ID ? "coordinator" : "owner-terminal", id: userInfo().username, channel: "factory-cli" };
}

export function parsePayload(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

