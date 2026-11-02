import type { AgentProfile } from "./schema.js";

/** Exhaustive over {@link AgentProfile}, so a new field fails to compile until it is listed here. */
const PROFILE_KEYS: Record<Exclude<keyof AgentProfile, "warnings">, true> = {
  name: true,
  description: true,
  harness: true,
  model: true,
  allowedTools: true,
  disallowedTools: true,
  isolation: true,
  surface: true,
  surfaceLifetime: true,
  role: true,
  remoteControl: true,
  returnContract: true,
  effort: true,
  cacheTtl: true,
  pushPolicy: true,
  promptPrelude: true,
  mcpServers: true,
  strictMcpConfig: true,
  settingSources: true,
  disableSlashCommands: true,
  env: true,
};

/** CC-558: a live profile listed tools under `denies`, which no field read, so the tools stayed reachable. */
export const DENY_ALIAS = "denies";

/** Fields a profile file may not set, with why. Silently ignoring them would be worse. */
export const FORBIDDEN_FIELDS: Readonly<Record<string, string>> = {
  permissionMode:
    "a profile widens a posture by naming tools, which is reviewable in a diff; a mode flag widens it by category, which is not",
  permission_mode: "see permissionMode",
};

export const LEAN_FLAGS = ["strictMcpConfig", "disableSlashCommands"] as const;

export const unknownKeyWarnings = (file: string, body: Record<string, unknown>): string[] =>
  Object.keys(body)
    .filter((key) => key !== DENY_ALIAS && !Object.hasOwn(PROFILE_KEYS, key))
    .map((key) => `${file}: unknown key "${key}" is ignored; no AgentProfile field has that name`);
