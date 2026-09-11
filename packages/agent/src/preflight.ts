import { conversationRef } from "@titan-design/agent-protocol";
import type {
  BoundedRunBase,
  CapabilityAssessment,
  ExecutionCapability,
  ExecutionLimit,
  Harness,
  HarnessAdapter,
  HarnessCapabilityDescriptor,
  HarnessRunFailure,
  HarnessRunRequestFor,
  HarnessRunResult,
  LimitCapability,
  LimitUnit,
} from "./harness-contracts.js";
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOXES } from "./harness-contracts.js";

export function preflightHarnessRun<H extends Harness, T>(
  request: HarnessRunRequestFor<H, T>,
  descriptor: HarnessCapabilityDescriptor<H>,
): HarnessRunFailure | undefined {
  if (request.harness !== descriptor.harness) {
    return mismatch(`request harness ${request.harness} does not match adapter harness ${descriptor.harness}`);
  }
  if (request.target.kind === "resume" && request.target.conversation.harness !== request.harness) {
    return mismatch(`resume conversation harness ${request.target.conversation.harness} does not match ${request.harness}`);
  }
  const identityFailure = invalidIdentity(request);
  if (identityFailure) return identityFailure;
  const invalid = invalidNumbers(request);
  if (invalid) return invalid;
  const nativeFailure = invalidNativeOptions(request);
  if (nativeFailure) return nativeFailure;
  if (request.signal?.aborted) return { kind: "aborted", reason: String(request.signal.reason ?? "aborted by caller") };
  const capabilityFailure = checkCapabilities(request, descriptor);
  if (capabilityFailure) return capabilityFailure;
  return checkLimits(request, descriptor);
}

function invalidIdentity(request: BoundedRunBase): HarnessRunFailure | undefined {
  if (request.target.kind === "fresh") {
    return nonempty(request.target.namespace) ? undefined : invalid("fresh target namespace must be a nonempty string");
  }
  try {
    conversationRef(request.target.conversation);
    return undefined;
  } catch {
    return invalid("resume conversation identity components must be nonempty strings");
  }
}

const CLAUDE_ONLY = ["allowedTools", "disallowedTools", "permissionMode", "agents", "mcpServers", "hooks", "settingSources", "allowApiKeyBilling"];
const CODEX_ONLY = ["reasoningEffort", "sandbox", "approvalPolicy"];
const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
const CLAUDE_SETTING_SOURCES = ["user", "project", "local"];

function invalidNativeOptions(request: { harness: Harness; native?: unknown }): HarnessRunFailure | undefined {
  if (request.native === undefined) return undefined;
  if (!record(request.native)) return invalid("native options must be an object");
  const native: object = request.native;
  const forbidden = request.harness === "codex" ? CLAUDE_ONLY : CODEX_ONLY;
  const field = forbidden.find((name) => name in native);
  if (field) return invalid(`${field} is not a ${request.harness} native option`);
  const options = native as Record<string, unknown>;
  return request.harness === "codex" ? invalidCodexOptions(options) : invalidClaudeOptions(options);
}

function invalidCodexOptions(options: Record<string, unknown>): HarnessRunFailure | undefined {
  const invalidModel = optionalNonempty("model", options.model);
  if (invalidModel) return invalidModel;
  const invalidEffort = optionalNonempty("reasoningEffort", options.reasoningEffort);
  if (invalidEffort) return invalidEffort;
  const enums = [
    ["sandbox", options.sandbox, CODEX_SANDBOXES],
    ["approvalPolicy", options.approvalPolicy, CODEX_APPROVAL_POLICIES],
  ] as const;
  for (const [name, value, allowed] of enums) {
    if (value !== undefined && !allowed.includes(value as never)) return invalid(`${name} is not a recognized Codex value`);
  }
  if (options.outputSchema === undefined) return undefined;
  if (!record(options.outputSchema)) return invalid("Codex outputSchema must be an object");
  if (!record(options.outputSchema.jsonSchema)) return invalid("Codex outputSchema.jsonSchema must be an object");
  return typeof options.outputSchema.parse === "function" ? undefined : invalid("Codex outputSchema.parse must be callable");
}

function invalidClaudeOptions(options: Record<string, unknown>): HarnessRunFailure | undefined {
  const invalidModel = optionalNonempty("model", options.model);
  if (invalidModel) return invalidModel;
  if (options.permissionMode !== undefined && !CLAUDE_PERMISSION_MODES.includes(options.permissionMode as never)) {
    return invalid("permissionMode is not a recognized Claude Code value");
  }
  for (const name of ["allowedTools", "disallowedTools"] as const) {
    if (options[name] !== undefined && !stringArray(options[name])) return invalid(`${name} must be an array of strings`);
  }
  if (options.settingSources !== undefined && !enumArray(options.settingSources, CLAUDE_SETTING_SOURCES)) {
    return invalid("settingSources must contain recognized Claude Code values");
  }
  if (options.allowApiKeyBilling !== undefined && typeof options.allowApiKeyBilling !== "boolean") {
    return invalid("allowApiKeyBilling must be boolean");
  }
  if (options.outputSchema !== undefined && (!record(options.outputSchema) || typeof options.outputSchema.safeParse !== "function")) {
    return invalid("Claude Code outputSchema must be a Zod schema");
  }
  return undefined;
}

export async function dispatchHarnessRun<H extends Harness, T>(
  request: HarnessRunRequestFor<H, T>,
  adapter: HarnessAdapter<H>,
): Promise<HarnessRunResult<T, H>> {
  const failure = preflightHarnessRun(request, adapter.descriptor);
  if (failure) return { ok: false, harness: request.harness as H, failure, usage: [] };
  try {
    return await adapter.run(request);
  } catch (error) {
    return {
      ok: false,
      harness: request.harness as H,
      failure: { kind: "runtime_error", reason: messageOf(error), native: error },
      usage: [],
    };
  }
}

function invalidNumbers(request: BoundedRunBase): HarnessRunFailure | undefined {
  if (!positiveFinite(request.wallTimeMs)) return invalid("wallTimeMs must be a positive finite number");
  for (const limit of request.limits ?? []) {
    if (!positiveFinite(limit.value)) return invalid(`${limit.unit} limit must be a positive finite number`);
    if (limit.unit !== "usd" && !Number.isInteger(limit.value)) {
      return invalid(`${limit.unit} limit must be a positive integer`);
    }
  }
  return undefined;
}

function checkCapabilities<H extends Harness, T>(
  request: HarnessRunRequestFor<H, T>,
  descriptor: HarnessCapabilityDescriptor<H>,
): HarnessRunFailure | undefined {
  for (const capability of requiredCapabilities(request)) {
    const assessment = descriptor.capabilities[capability] ?? {
      status: "unverified",
      reason: "adapter did not declare this capability",
    };
    const failure = rejectAssessment(assessment, { kind: "capability", capability });
    if (failure) return failure;
  }
  return undefined;
}

function requiredCapabilities(request: BoundedRunBase & { native?: { outputSchema?: unknown } }): ExecutionCapability[] {
  const required = new Set<ExecutionCapability>(request.requires ?? []);
  required.add(request.target.kind === "fresh" ? "fresh_run" : "resume");
  if (request.native?.outputSchema !== undefined) required.add("structured_output");
  if (request.signal) required.add("external_cancellation");
  return [...required];
}

function checkLimits<H extends Harness, T>(
  request: HarnessRunRequestFor<H, T>,
  descriptor: HarnessCapabilityDescriptor<H>,
): HarnessRunFailure | undefined {
  const wallTime: ExecutionLimitRecord = {
    unit: "milliseconds",
    value: request.wallTimeMs,
    scope: "execution",
    enforcement: "hard",
  };
  for (const limit of [wallTime, ...(request.limits ?? [])]) {
    const declared = descriptor.limits.find((candidate) => sameLimit(candidate, limit));
    const assessment = declared?.assessment ?? { status: "unverified", reason: "adapter did not declare this limit" };
    const requirement = { kind: "limit" as const, limit: { ...limit, assessment } };
    const failure = rejectAssessment(assessment, requirement);
    if (failure) return failure;
  }
  return undefined;
}

type ExecutionLimitRecord = ExecutionLimit | {
  unit: "milliseconds";
  value: number;
  scope: "execution";
  enforcement: "hard";
};

function sameLimit(capability: LimitCapability, limit: ExecutionLimitRecord): boolean {
  return capability.unit === limit.unit && capability.scope === limit.scope && capability.enforcement === limit.enforcement;
}

function rejectAssessment(
  assessment: CapabilityAssessment,
  requirement: Extract<HarnessRunFailure, { kind: "unsupported_requirement" }>["requirement"],
): HarnessRunFailure | undefined {
  if (assessment.status === "supported") return undefined;
  const name = requirement.kind === "capability" ? requirement.capability : describeLimit(requirement.limit);
  return { kind: "unsupported_requirement", reason: `${name} is ${assessment.status}: ${assessment.reason}`, requirement, status: assessment.status };
}

function describeLimit(limit: { unit: LimitUnit; scope: string; enforcement: string }): string {
  return `${limit.enforcement} ${limit.scope} limit in ${limit.unit}`;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonempty(name: string, value: unknown): HarnessRunFailure | undefined {
  return value === undefined || nonempty(value) ? undefined : invalid(`${name} must be a nonempty string`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function enumArray(value: unknown, allowed: readonly string[]): boolean {
  return stringArray(value) && value.every((item) => allowed.includes(item));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(reason: string): HarnessRunFailure {
  return { kind: "invalid_request", reason };
}

function mismatch(reason: string): HarnessRunFailure {
  return { kind: "harness_mismatch", reason };
}
