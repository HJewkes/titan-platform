import { z } from "zod";

interface EventMeta {
  toolName: string;
  cwd: string | null;
  sessionId: string | null;
  toolUseId: string | null;
}

/** One PreToolUse event reduced to what the classifier reads. Unknown tools become `other`. */
export type HookEvent =
  | (EventMeta & { kind: "bash"; command: string })
  /** Read, and Grep, whose missing path becomes `.`; a relative path resolves against `cwd`. */
  | (EventMeta & { kind: "read"; path: string })
  /** Edit, Write, MultiEdit and NotebookEdit. */
  | (EventMeta & { kind: "write"; path: string })
  | { kind: "other"; toolName: string };

export type ReadEvent = Extract<HookEvent, { kind: "read" }>;
export type WriteEvent = Extract<HookEvent, { kind: "write" }>;

/** An event whose shape broke Claude Code's contract; the hook fails open on it and logs `shape`. */
export interface MalformedEvent {
  kind: "malformed";
  toolName: string | null;
}

const nullable = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const envelope = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  cwd: nullable,
  session_id: nullable,
  tool_use_id: nullable,
});

type Envelope = z.infer<typeof envelope>;

const INPUTS: Record<string, (input: Record<string, unknown>) => HookInput | null> = {
  Bash: (input) => field(input, "command", "bash", z.string()),
  Read: (input) => field(input, "file_path", "read", z.string().min(1)),
  Grep: (input) => (input.path === undefined ? { kind: "read", path: "." } : field(input, "path", "read", z.string().min(1))),
  Edit: (input) => field(input, "file_path", "write", z.string().min(1)),
  Write: (input) => field(input, "file_path", "write", z.string().min(1)),
  MultiEdit: (input) => field(input, "file_path", "write", z.string().min(1)),
  NotebookEdit: (input) => field(input, "notebook_path", "write", z.string().min(1)),
};

type HookInput = { kind: "bash"; command: string } | { kind: "read" | "write"; path: string };

/** Validates a parsed PreToolUse payload. Never throws. */
export function parseHookEvent(raw: unknown): HookEvent | MalformedEvent {
  const outer = envelope.safeParse(raw);
  if (!outer.success) return { kind: "malformed", toolName: toolNameOf(raw) };
  const e = outer.data;
  const reader = Object.hasOwn(INPUTS, e.tool_name) ? INPUTS[e.tool_name] : undefined;
  if (!reader) return { kind: "other", toolName: e.tool_name };
  const input = reader(e.tool_input);
  if (!input) return { kind: "malformed", toolName: e.tool_name };
  return { ...input, ...meta(e) } as HookEvent;
}

function meta(e: Envelope): EventMeta {
  return { toolName: e.tool_name, cwd: e.cwd, sessionId: e.session_id, toolUseId: e.tool_use_id };
}

function field(input: Record<string, unknown>, key: string, kind: HookInput["kind"], schema: z.ZodString): HookInput | null {
  const value = schema.safeParse(input[key]);
  if (!value.success) return null;
  return kind === "bash" ? { kind, command: value.data } : { kind, path: value.data };
}

function toolNameOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as Record<string, unknown>).tool_name;
  return typeof name === "string" ? name : null;
}
