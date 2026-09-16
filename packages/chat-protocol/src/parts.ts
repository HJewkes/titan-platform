import { z } from "zod";

/**
 * A byte-compatible subset of the Vercel AI SDK `UIMessagePart` union, vendored
 * rather than imported: tier 0 carries no runtime dependency beyond zod as a
 * peer. `ai` is a devDependency only, and `ai-compat.test.ts` round-trips a real
 * `UIMessage` through these schemas so the subset cannot drift silently.
 *
 * Verified against ai@7.0.102.
 */
export type PartStreamState = "streaming" | "done";

/**
 * Opaque to this package and preserved verbatim. Anthropic's thinking signature
 * rides here, and a resumed run breaks if a persistence layer drops it.
 */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

export interface TextPart {
  type: "text";
  text: string;
  state?: PartStreamState;
  providerMetadata?: ProviderMetadata;
}

export interface ReasoningPart {
  type: "reasoning";
  id?: string;
  text: string;
  state?: PartStreamState;
  providerMetadata?: ProviderMetadata;
}

export interface SourceUrlPart {
  type: "source-url";
  sourceId: string;
  url: string;
  title?: string;
}

export interface SourceDocumentPart {
  type: "source-document";
  sourceId: string;
  mediaType: string;
  title: string;
  filename?: string;
}

export interface FilePart {
  type: "file";
  mediaType: string;
  filename?: string;
  url: string;
}

export interface StepStartPart {
  type: "step-start";
}

/**
 * The approval state machine the AI SDK already ships. `approval-requested` is
 * the inbound permission prompt, `approval-responded` the verdict, and
 * `output-denied` the refusal — no titan part type is added for any of them.
 */
export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface ToolApproval {
  id: string;
  approved?: boolean;
  descriptor?: unknown;
  reason?: string;
  signature?: string;
}

export interface ToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: ToolPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: ToolApproval;
  providerExecuted?: boolean;
  callProviderMetadata?: ProviderMetadata;
  resultProviderMetadata?: ProviderMetadata;
}

export interface DataPart {
  type: `data-${string}`;
  id?: string;
  data: unknown;
}

export type ChatPart =
  | TextPart
  | ReasoningPart
  | SourceUrlPart
  | SourceDocumentPart
  | FilePart
  | StepStartPart
  | ToolPart
  | DataPart;

/**
 * A Claude Code channel turns every `meta` entry into an attribute and silently
 * drops any key that is not an identifier. A `data-` suffix therefore may not
 * contain a hyphen, or the part loses its routing context with no error.
 */
export const DATA_PART_KEY_PATTERN = /^data-[A-Za-z_][A-Za-z0-9_]*$/;

const TOOL_PART_TYPE_PATTERN = /^tool-.+$/;

export function isDataPartType(type: string): type is `data-${string}` {
  return DATA_PART_KEY_PATTERN.test(type);
}

export function isToolPartType(type: string): type is `tool-${string}` {
  return TOOL_PART_TYPE_PATTERN.test(type);
}

const partStreamState = z.enum(["streaming", "done"]);

export const providerMetadata = z.record(z.string(), z.record(z.string(), z.unknown()));

export const textPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  state: partStreamState.optional(),
  providerMetadata: providerMetadata.optional(),
});

export const reasoningPart = z.object({
  type: z.literal("reasoning"),
  id: z.string().optional(),
  text: z.string(),
  state: partStreamState.optional(),
  providerMetadata: providerMetadata.optional(),
});

export const sourceUrlPart = z.object({
  type: z.literal("source-url"),
  sourceId: z.string(),
  url: z.string(),
  title: z.string().optional(),
});

export const sourceDocumentPart = z.object({
  type: z.literal("source-document"),
  sourceId: z.string(),
  mediaType: z.string(),
  title: z.string(),
  filename: z.string().optional(),
});

export const filePart = z.object({
  type: z.literal("file"),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
});

export const stepStartPart = z.object({
  type: z.literal("step-start"),
});

export const toolApproval = z.object({
  id: z.string().min(1),
  approved: z.boolean().optional(),
  descriptor: z.unknown().optional(),
  reason: z.string().optional(),
  signature: z.string().optional(),
});

export const toolPart = z
  .object({
    type: z.custom<`tool-${string}`>((value) => typeof value === "string" && isToolPartType(value), {
      message: "a tool part type must be `tool-<name>`",
    }),
    toolCallId: z.string().min(1),
    state: z.enum([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied",
    ]),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    errorText: z.string().optional(),
    approval: toolApproval.optional(),
    providerExecuted: z.boolean().optional(),
    callProviderMetadata: providerMetadata.optional(),
    resultProviderMetadata: providerMetadata.optional(),
  })
  .superRefine(checkToolPartState);

/** Anything titan-specific rides here; `data` stays `unknown` so the protocol never owns a payload. */
export const dataPart = z.object({
  type: z.custom<`data-${string}`>((value) => typeof value === "string" && isDataPartType(value), {
    message: "a data part key must be `data-<identifier>`; hyphens after the prefix are dropped by Claude Code channels",
  }),
  id: z.string().optional(),
  data: z.unknown(),
});

export const chatPart = z.union([
  textPart,
  reasoningPart,
  sourceUrlPart,
  sourceDocumentPart,
  filePart,
  stepStartPart,
  toolPart,
  dataPart,
]);

const STATES_NEEDING_APPROVAL = new Set<ToolPartState>([
  "approval-requested",
  "approval-responded",
  "output-denied",
]);

function checkToolPartState(part: ToolPart, ctx: z.RefinementCtx): void {
  const fail = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
  if (STATES_NEEDING_APPROVAL.has(part.state) && !part.approval) {
    fail(`state ${part.state} requires an approval`, "approval");
  }
  if (part.state === "approval-responded" && part.approval?.approved === undefined) {
    fail("an answered approval must say whether it was approved", "approval");
  }
  if (part.state === "output-denied" && part.approval?.approved !== false) {
    fail("a denied output must carry approved: false", "approval");
  }
  if (part.state === "output-error" && part.errorText === undefined) {
    fail("state output-error requires errorText", "errorText");
  }
}
