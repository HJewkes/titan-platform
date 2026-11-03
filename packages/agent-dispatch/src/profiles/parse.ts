/**
 * Validate a parsed profile file, ported from agent-chat's `parseProfile` and split by field
 * family so each check reads on its own. The checks run in agent-chat's order, so a file with
 * several faults is refused with the same first message.
 */

import { harnessError } from "./harness.js";
import { DENY_ALIAS, FORBIDDEN_FIELDS, LEAN_FLAGS, unknownKeyWarnings } from "./keys.js";
import {
  AGENT_ROLES,
  CACHE_TTLS,
  CONTRACT_CHOICES,
  EFFORT_LEVELS,
  ISOLATION_NAMES,
  PUSH_POLICIES,
  SETTING_SOURCES,
  SURFACE_LIFETIMES,
  SURFACE_NAMES,
  isCacheTtl,
  isContractChoice,
  isHarness,
  isPushPolicy,
  isRole,
  isSettingSource,
  type AgentProfile,
  type AgentRole,
  type CacheTtl,
  type ContractChoice,
  type EffortLevel,
  type IsolationName,
  type PushPolicy,
  type SettingSource,
  type SurfaceLifetime,
  type SurfaceName,
} from "./schema.js";

type Body = Record<string, unknown>;

/** A body every check passed: what the checks establish, written down for the compiler. */
interface ValidBody extends Body {
  model: string;
  allowedTools: string[];
  disallowedTools?: string[];
  [DENY_ALIAS]?: string[];
  isolation: IsolationName;
  surface: SurfaceName;
  surfaceLifetime?: SurfaceLifetime;
  role?: AgentRole;
  remoteControl?: boolean;
  returnContract?: ContractChoice;
  effort?: EffortLevel;
  cacheTtl?: CacheTtl;
  pushPolicy?: PushPolicy;
  env?: Record<string, string>;
  settingSources?: SettingSource[];
}

/** A refusal for one field family, or undefined when the family is valid. */
type Check = (name: string, body: Body) => string | undefined;

export type ProfileParseResult = AgentProfile | { error: string };

const isObject = (value: unknown): value is Body => typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isSettingSources = (value: unknown): value is SettingSource[] =>
  isStringArray(value) && value.every(isSettingSource);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isObject(value) && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");

function oneOfError(name: string, body: Body, field: string, values: readonly string[], required: boolean): string | undefined {
  const value = body[field];
  if (!required && value === undefined) return undefined;
  return values.some((entry) => entry === value) ? undefined : `${name}: "${field}" must be one of ${values.join(", ")}`;
}

function stringListError(name: string, body: Body, field: string, required: boolean): string | undefined {
  const value = body[field];
  if (!required && value === undefined) return undefined;
  return isStringArray(value) ? undefined : `${name}: "${field}" must be an array of strings`;
}

const requiredError: Check = (name, body) => {
  for (const [field, why] of Object.entries(FORBIDDEN_FIELDS))
    if (field in body) return `${name}: "${field}" is not allowed — ${why}`;
  if (typeof body.model !== "string" || body.model === "") return `${name}: "model" is required`;
  return undefined;
};

const toolListError: Check = (name, body) =>
  stringListError(name, body, "allowedTools", true) ??
  stringListError(name, body, "disallowedTools", false) ??
  stringListError(name, body, DENY_ALIAS, false);

const placementError: Check = (name, body) =>
  oneOfError(name, body, "isolation", ISOLATION_NAMES, true) ??
  oneOfError(name, body, "surface", SURFACE_NAMES, true) ??
  oneOfError(name, body, "surfaceLifetime", SURFACE_LIFETIMES, false);

const roleError: Check = (name, body) => {
  const role = oneOfError(name, body, "role", AGENT_ROLES, false);
  if (role !== undefined) return role;
  if (body.remoteControl !== undefined && typeof body.remoteControl !== "boolean")
    return `${name}: "remoteControl" must be true or false`;
  if (body.remoteControl === true && body.role !== "coordinator")
    return `${name}: "remoteControl" needs "role": "coordinator"; a worker profile cannot run with Remote Control`;
  return undefined;
};

const optionError: Check = (name, body) =>
  oneOfError(name, body, "returnContract", CONTRACT_CHOICES, false) ??
  oneOfError(name, body, "effort", EFFORT_LEVELS, false) ??
  oneOfError(name, body, "cacheTtl", CACHE_TTLS, false) ??
  oneOfError(name, body, "pushPolicy", PUSH_POLICIES, false);

const environmentError: Check = (name, body) => {
  if (body.env !== undefined && !isStringRecord(body.env))
    return `${name}: "env" must be an object whose values are all strings`;
  if (body.settingSources !== undefined && !isSettingSources(body.settingSources))
    return `${name}: "settingSources" must be an array drawn from ${SETTING_SOURCES.join(", ")}`;
  const flag = LEAN_FLAGS.find((field) => body[field] !== undefined && typeof body[field] !== "boolean");
  return flag === undefined ? undefined : `${name}: "${flag}" must be true or false`;
};

const CHECKS: readonly Check[] = [
  requiredError,
  harnessError,
  toolListError,
  placementError,
  roleError,
  optionError,
  environmentError,
];

const APPROVE_DENY = "Bash(agent-chat approve:*)";

/** A deny a file implies by denying `when`, unless it allows that pattern by name. */
interface DerivedDeny {
  deny: string;
  when: string[];
  why: string;
  /** Derived only for a worker-role file: a coordinator runs these verbs itself. */
  workersOnly?: true;
}

const DERIVED_DENIES: readonly DerivedDeny[] = [
  {
    // CC-558: `inbox --batch --answers` reaches approve and endorse through one door (CC-425).
    deny: "Bash(agent-chat inbox:*)",
    when: [APPROVE_DENY, "Bash(agent-chat endorse:*)"],
    why: "the file denies approve or endorse, and inbox reaches both",
  },
  {
    // CC-169: a file that keeps the human's verbs from an agent keeps it from asking under a service label too.
    deny: "Bash(agent-chat ask:*)",
    when: [APPROVE_DENY],
    why: "the file denies approve, and ask puts a question to the human under a service label",
  },
  {
    // CC-951: `teleport request` sends a from="human" message, the same door `send` closes.
    deny: "Bash(agent-chat teleport:*)",
    when: ["Bash(agent-chat send:*)"],
    why: "the file denies send, and teleport request sends a message as the human",
  },
  {
    // CC-1083: `debug send` sends `human_send` on an unregistered connection, so it speaks as the human.
    deny: "Bash(agent-chat debug send:*)",
    when: ["Bash(agent-chat send:*)"],
    why: "the file denies send, and debug send sends a message as the human",
  },
  {
    // CC-1138: a kicked tick spawns, resumes and retires with the tick's authority, not the caller's.
    deny: "Bash(agent-chat burndown:*)",
    when: ["Bash(agent-chat send:*)"],
    why: "the file denies send, and the burndown verbs spawn and retire agents as the human",
    workersOnly: true,
  },
  {
    // CC-1138: the seat verbs spawn and retire seats, and the watchdog sends `human_send`.
    deny: "Bash(agent-chat seats:*)",
    when: ["Bash(agent-chat send:*)"],
    why: "the file denies send, and the seats verbs spawn seats and message them as the human",
    workersOnly: true,
  },
];

const needs = ({ deny, when, workersOnly }: DerivedDeny, denied: string[], allowed: string[], role: unknown): boolean =>
  (workersOnly !== true || role !== "coordinator") &&
  when.some((verb) => denied.includes(verb)) &&
  !denied.includes(deny) &&
  !allowed.some((tool) => tool.startsWith(deny.slice(0, deny.indexOf(":"))));

/** `disallowedTools` and its alias as one list, plus each derived deny the file needs. */
function fileDenies(file: string, body: ValidBody): { denied?: string[]; warnings: string[] } {
  const listed = [...(body.disallowedTools ?? []), ...(body[DENY_ALIAS] ?? [])];
  const denied = [...new Set(listed)];
  const added = DERIVED_DENIES.filter((rule) => needs(rule, denied, body.allowedTools, body.role));
  const warnings = added.map(({ deny, why }) => `${file}: "${deny}" is denied too; ${why}`);
  const named = body.disallowedTools !== undefined || body[DENY_ALIAS] !== undefined;
  if (!named && added.length === 0) return { warnings };
  return { denied: [...denied, ...added.map((rule) => rule.deny)], warnings };
}

function identityFields(name: string, body: ValidBody, denied: string[] | undefined) {
  return {
    name,
    description: typeof body.description === "string" ? body.description : "",
    ...(isHarness(body.harness) ? { harness: body.harness } : {}),
    model: body.model,
    allowedTools: body.allowedTools,
    ...(denied === undefined ? {} : { disallowedTools: denied }),
  };
}

function placementFields(body: ValidBody) {
  return {
    isolation: body.isolation,
    surface: body.surface,
    ...(body.surfaceLifetime === undefined ? {} : { surfaceLifetime: body.surfaceLifetime }),
    ...(isRole(body.role) ? { role: body.role } : {}),
    ...(body.remoteControl === true ? { remoteControl: true } : {}),
  };
}

function optionFields(body: ValidBody) {
  return {
    ...(isContractChoice(body.returnContract) ? { returnContract: body.returnContract } : {}),
    ...(body.effort === undefined ? {} : { effort: body.effort }),
    ...(isCacheTtl(body.cacheTtl) ? { cacheTtl: body.cacheTtl } : {}),
    ...(isPushPolicy(body.pushPolicy) ? { pushPolicy: body.pushPolicy } : {}),
    promptPrelude: typeof body.promptPrelude === "string" ? body.promptPrelude : "",
  };
}

function extraFields(body: ValidBody, warnings: string[]): Partial<AgentProfile> {
  return {
    ...(isObject(body.mcpServers) ? { mcpServers: body.mcpServers } : {}),
    ...(body.env === undefined ? {} : { env: body.env }),
    ...(body.settingSources === undefined ? {} : { settingSources: body.settingSources }),
    ...Object.fromEntries(LEAN_FLAGS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]])),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** The first family's refusal, or undefined when every check passed and `body` is a {@link ValidBody}. */
function firstError(name: string, body: Body): string | undefined {
  for (const check of CHECKS) {
    const error = check(name, body);
    if (error !== undefined) return error;
  }
  return undefined;
}

const checked = (body: Body, error: string | undefined): body is ValidBody => error === undefined;

function buildProfile(name: string, file: string, body: ValidBody): AgentProfile {
  const denies = fileDenies(file, body);
  const warnings = [...unknownKeyWarnings(file, body), ...denies.warnings];
  return {
    ...identityFields(name, body, denies.denied),
    ...placementFields(body),
    ...optionFields(body),
    ...extraFields(body, warnings),
  };
}

/**
 * Returns the profile or an explanatory error, never a partially-trusted object: a profile that
 * half-loaded would grant whatever its defaults happened to be.
 */
export function parseProfile(name: string, raw: unknown, file: string = `${name}.json`): ProfileParseResult {
  if (!isObject(raw)) return { error: `${name}: not a JSON object` };
  const error = firstError(name, raw);
  return checked(raw, error) ? buildProfile(name, file, raw) : { error: String(error) };
}
