import type { ChatMessage } from "../envelope.js";
import type { ToolPart } from "../parts.js";

/**
 * `@titan-design/hitl` is tier 1, so `GateSnapshot` mirrors its `GateRecord`
 * structurally instead of importing it. The row stays in hitl: this is a
 * render-time view, and resolving still goes through `resolveGate`.
 */
export interface GateSnapshot {
  id: string;
  prompt: string;
  schema?: Record<string, unknown>;
  status: "pending" | "resolved" | "cancelled" | "expired";
  payload?: unknown;
  reason?: string;
  createdAt: string;
  expiresAt?: string;
}

/** A gate is not a named tool, so every gate renders under one stable tool name. */
export const GATE_TOOL_NAME = "gate";
export const GATE_PART_TYPE = `tool-${GATE_TOOL_NAME}` as const;

export interface GateContext {
  threadId: string;
  /** A gate row has no author field; the opener supplies one. */
  authorId: string;
}

/**
 * MCP elicitation's `cancel` has no chat representation: a dismissed gate is
 * cancelled through `cancelGate`, not by sending a message.
 */
export type GateAnswer =
  | { action: "accept"; gateId: string; payload: unknown }
  | { action: "decline"; gateId: string; reason: string };

/** A pending gate is an approval request carrying its JSON Schema as the descriptor. */
export function fromHitlGate(gate: GateSnapshot, context: GateContext): ChatMessage {
  return {
    id: `gate:${gate.id}`,
    threadId: context.threadId,
    authorId: context.authorId,
    role: "assistant",
    createdAt: gate.createdAt,
    parts: [gatePart(gate)],
  };
}

/**
 * Reads the verdict back out so a caller can hand it to `resolveGate` or
 * `cancelGate`. Returns undefined while the gate is still open.
 */
export function toHitlAnswer(message: ChatMessage): GateAnswer | undefined {
  const part = message.parts.find(isGatePart);
  if (!part?.approval) return undefined;
  const gateId = part.approval.id;
  if (part.state === "output-available") return { action: "accept", gateId, payload: part.output };
  if (part.state === "output-denied") {
    return { action: "decline", gateId, reason: part.approval.reason ?? "declined" };
  }
  return undefined;
}

function isGatePart(part: ChatMessage["parts"][number]): part is ToolPart {
  return part.type === GATE_PART_TYPE;
}

function gatePart(gate: GateSnapshot): ToolPart {
  const base = { type: GATE_PART_TYPE, toolCallId: gate.id, input: gateInput(gate) };
  if (gate.status === "pending") {
    return { ...base, state: "approval-requested", approval: { id: gate.id, descriptor: gate.schema } };
  }
  if (gate.status === "resolved") {
    return { ...base, state: "output-available", output: gate.payload, approval: { id: gate.id, approved: true } };
  }
  return {
    ...base,
    state: "output-denied",
    approval: { id: gate.id, approved: false, reason: gate.reason ?? gate.status },
  };
}

function gateInput(gate: GateSnapshot): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: gate.prompt };
  if (gate.schema) input.schema = gate.schema;
  if (gate.expiresAt) input.expiresAt = gate.expiresAt;
  return input;
}
