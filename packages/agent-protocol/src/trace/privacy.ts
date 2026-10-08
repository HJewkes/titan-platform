import type { TraceRecord } from "./index.js";

/**
 * export: kept. digest: replaced by `hmac-sha256:<hex>` keyed by the export's key, so equal values join
 * within one export and a guess can't be confirmed without the key.
 * public: kept only when the record's repo is public, else digested. local: dropped.
 * mcp-local: local when the tool call belongs to an MCP server, else export. actor: digest for `agent:` actors, else export.
 */
export type TracePrivacyClass = "export" | "digest" | "public" | "local" | "mcp-local" | "actor";

export type TracePrivacyScope = "run" | "attempt" | "call" | "gate" | "artifact.commit" | "artifact.pr" | "artifact.file" | "cost";

type ClassMap = Readonly<Record<string, TracePrivacyClass>>;

const ENVELOPE = { schema: "export", kind: "export", runId: "export", at: "export" } as const;
const STEP_ENVELOPE = { ...ENVELOPE, attemptId: "export" } as const;
const SPAN = { "span.sourceId": "digest", "span.byteOffset": "export", "span.byteLength": "export", "span.contentHash": "local" } as const;
const TOKENS = ["input", "output", "cachedInput", "cacheWriteInput", "reasoningOutput", "total"].map((name) => [`measurement.tokens.${name}`, "export"] as const);
const MEASUREMENT = {
  ...Object.fromEntries(TOKENS),
  "measurement.model": "export",
  "measurement.cost.usd": "export",
  "measurement.cost.kind": "export",
  "measurement.source": "export",
  "measurement.kind": "export",
  "measurement.responseId": "digest",
  "measurement.scope": "export",
  "measurement.scopeId": "digest",
  "measurement.epoch": "digest",
  "measurement.sequence": "export",
} as const satisfies ClassMap;
const ARTIFACT = { ...STEP_ENVELOPE, ...SPAN, id: "public", artifactKind: "export", repo: "public" } as const;

/** Every leaf path of every record kind; `*` stands for any record key, `[]` for any array element. */
export const TRACE_FIELD_PRIVACY: Readonly<Record<TracePrivacyScope, ClassMap>> = {
  run: {
    ...ENVELOPE,
    id: "export",
    workflowName: "export",
    status: "export",
    completedAt: "export",
    error: "local",
    "correlations.*": "local",
    paramsSha256: "export",
  },
  attempt: {
    ...ENVELOPE,
    id: "export",
    stepId: "export",
    iteration: "export",
    attempt: "export",
    stepKind: "export",
    executionId: "digest",
    phase: "export",
    outcome: "export",
    retryable: "export",
    error: "local",
    signal: "export",
    runnerRef: "digest",
    agentId: "digest",
    conversation: "digest",
    model: "export",
    completedAt: "export",
    "usage.costUsd": "export",
    "usage.inputTokens": "export",
    "usage.outputTokens": "export",
    "recovery.kind": "export",
    "recovery.observedAt": "export",
    promptSha256: "export",
    outputSha256: "export",
  },
  call: { ...STEP_ENVELOPE, ...SPAN, id: "digest", callKind: "export", name: "mcp-local", namespace: "digest", conversation: "digest", turn: "digest", isError: "export" },
  gate: {
    ...STEP_ENVELOPE,
    id: "export",
    gateKind: "export",
    status: "export",
    verdict: "export",
    decidedBy: "actor",
    "policyRule.table": "export",
    "policyRule.rowId": "export",
    "policyRule.version": "export",
    resolvedAt: "export",
    expiresAt: "export",
    reason: "local",
    promptSha256: "export",
    payloadSha256: "export",
  },
  "artifact.commit": { ...ARTIFACT, sha: "public", branch: "public", reverts: "public" },
  "artifact.pr": { ...ARTIFACT, number: "public", state: "export", mergedAt: "export", closedAt: "export", reviewRounds: "export", checks: "export" },
  "artifact.file": { ...ARTIFACT, path: "public", commit: "public", "lines[].lineStart": "public", "lines[].lineEnd": "public" },
  cost: { ...STEP_ENVELOPE, ...SPAN, ...MEASUREMENT, id: "digest", conversation: "digest" },
};

/** Correlation keys survive redaction so a reader can see which joins existed; their values are replaced by this marker. */
export const REDACTED_LOCAL_VALUE = "[local]";

export interface RedactTraceOptions {
  /** `owner/name` repos whose ids, paths and shas may leave the machine. */
  publicRepos: readonly string[];
  /** Secret HMAC key for this export. Reuse it to join across exports; never ship it with the export. */
  key: string;
}

interface RedactContext {
  classes: ClassMap;
  key: CryptoKey;
  isPublic: boolean;
  isMcpTool: boolean;
}

export function tracePrivacyScope(record: TraceRecord): TracePrivacyScope {
  return record.kind === "artifact" ? `artifact.${record.artifactKind}` : record.kind;
}

/** Keys with no class, such as extras kept by a loose parse, are dropped. */
export async function redactTraceRecord(record: TraceRecord, options: RedactTraceOptions): Promise<Record<string, unknown>> {
  const context: RedactContext = {
    classes: TRACE_FIELD_PRIVACY[tracePrivacyScope(record)],
    key: await importDigestKey(options.key),
    isPublic: "repo" in record && options.publicRepos.includes(record.repo),
    isMcpTool: record.kind === "call" && record.callKind === "tool" && (Boolean(record.namespace) || record.name.startsWith("mcp__")),
  };
  return redactObject(record as unknown as Record<string, unknown>, "", context);
}

async function redactObject(value: Record<string, unknown>, prefix: string, context: RedactContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}${key}`;
    const redacted = await redactNode(child, path, context);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

async function redactNode(value: unknown, path: string, context: RedactContext): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => redactNode(item, `${path}[]`, context)));
  if (value === null || typeof value !== "object") return redactLeaf(value, context.classes[path], context);
  if (context.classes[`${path}.*`] === "local") return Object.fromEntries(Object.keys(value).map((key) => [key, REDACTED_LOCAL_VALUE]));
  return redactObject(value as Record<string, unknown>, `${path}.`, context);
}

async function redactLeaf(value: unknown, privacy: TracePrivacyClass | undefined, context: RedactContext): Promise<unknown> {
  switch (privacy) {
    case "export":
      return value;
    case "digest":
      return digest(value, context.key);
    case "public":
      return context.isPublic ? value : digest(value, context.key);
    case "mcp-local":
      return context.isMcpTool ? undefined : value;
    case "actor":
      return typeof value === "string" && value.startsWith("agent:") ? digest(value, context.key) : value;
    default:
      return undefined;
  }
}

function importDigestKey(key: string): Promise<CryptoKey> {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("redactTraceRecord needs a non-empty options.key");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function digest(value: unknown, key: CryptoKey): Promise<unknown> {
  if (value === null || value === undefined) return value;
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value)));
  return `hmac-sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
