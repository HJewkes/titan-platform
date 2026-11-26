export const FULL_SHA = /^[0-9a-f]{40}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && FULL_SHA.test(value);
}

export interface AgentIdentity {
  agentId: string;
  sessionId: string;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function sameAgent(a: AgentIdentity, b: AgentIdentity): boolean {
  return isId(a.agentId) && isId(a.sessionId) && a.agentId === b.agentId && a.sessionId === b.sessionId;
}
