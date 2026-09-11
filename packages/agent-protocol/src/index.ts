/** Native conversation identity. Namespace identifies a host/account corpus, not a path. */
export interface ConversationIdentity {
  harness: string;
  namespace: string;
  nativeId: string;
}

/** Durable orchestration identity, independent of any one native conversation. */
export interface AgentIdentity { agentId: string }

/** One invocation; its native conversation may become known only after launch. */
export interface ExecutionIdentity {
  executionId: string;
  conversation?: ConversationIdentity;
}

/** Ownership is teardown authority, not evidence that the process is still alive. */
export interface SurfaceIdentity {
  kind: string;
  host: string;
  nativeId: string;
  owned: boolean;
}

/** Stable, collision-free key. Legacy session refs remain a separate alias vocabulary. */
export function conversationRef(identity: ConversationIdentity): string {
  return `conversation:${[identity.harness, identity.namespace, identity.nativeId].map(component).join(":")}`;
}

/** Call, turn and item IDs are unique within their conversation and category only. */
export function conversationItemRef(identity: ConversationIdentity, kind: "turn" | "call" | "item" | "response", nativeId: string): string {
  return `${kind}:${conversationRef(identity).slice("conversation:".length)}:${component(nativeId)}`;
}

function component(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("identity components must be nonempty strings");
  return encodeURIComponent(value);
}

/** Null means unreported. Input includes cache reads/writes; output includes reasoning. */
export interface TokenCounts {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  reasoningOutput: number | null;
  total: number | null;
}

/** Delta IDs deduplicate responses; snapshots replace by source order within a reset epoch. */
export type UsageMeasurement = {
  model: string | null;
  tokens: TokenCounts;
  cost: { usd: number; kind: "estimate" | "reported" } | null;
  source: string;
} & (
  | { kind: "delta"; responseId: string }
  | { kind: "snapshot"; scope: "turn" | "conversation"; scopeId: string; epoch: string; sequence: number }
);
