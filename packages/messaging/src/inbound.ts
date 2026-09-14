import { z } from "zod";

/**
 * Dedupe storage, injected. The package ships only the in-memory
 * implementation so it needs no database and stays runtime-neutral.
 */
export interface SeenStore {
  has(guid: string): Promise<boolean> | boolean;
  add(guid: string): Promise<void> | void;
}

export class MemorySeenStore implements SeenStore {
  private readonly guids = new Set<string>();

  has(guid: string): boolean {
    return this.guids.has(guid);
  }

  add(guid: string): void {
    this.guids.add(guid);
  }
}

export type InboundRejection =
  | "bad-secret"
  | "sender-not-allowed"
  | "duplicate"
  | "too-long"
  | "from-me"
  | "malformed";

export type InboundResult =
  | { status: "accepted"; handle: string; guid: string; text: string }
  | { status: "rejected"; reason: InboundRejection };

/** The `new-message` webhook body: WebhookService posts `{ type, data }`. */
export const newMessageEvent = z.object({
  type: z.literal("new-message"),
  data: z.object({
    guid: z.string().min(1),
    text: z.string().nullable(),
    isFromMe: z.boolean(),
    handle: z.object({ address: z.string().min(1) }).nullish(),
  }),
});

export interface ValidateInboundInput {
  pathSecret: string;
  expectedSecret: string;
  allowedHandles: readonly string[];
  body: unknown;
  maxTextLength: number;
  seen: SeenStore;
}

const encoder = new TextEncoder();

/** Compares over the longer of the two, so only the length can be timed. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function rejected(reason: InboundRejection): InboundResult {
  return { status: "rejected", reason };
}

function isAllowed(handle: string, allowed: readonly string[]): boolean {
  const normalized = handle.trim().toLowerCase();
  return allowed.some((entry) => entry.trim().toLowerCase() === normalized);
}

/**
 * Pure: every effect is in the injected `seen` store. BlueBubbles publishes no
 * request signature, so the secret path segment, the handle allowlist and the
 * GUID dedupe are the whole boundary.
 */
export async function validateInbound({
  pathSecret,
  expectedSecret,
  allowedHandles,
  body,
  maxTextLength,
  seen,
}: ValidateInboundInput): Promise<InboundResult> {
  if (!expectedSecret || !constantTimeEqual(pathSecret, expectedSecret)) {
    return rejected("bad-secret");
  }

  const parsed = newMessageEvent.safeParse(body);
  if (!parsed.success) return rejected("malformed");

  const { guid, text, isFromMe, handle } = parsed.data.data;
  if (isFromMe) return rejected("from-me");
  if (!handle) return rejected("malformed");
  if (!isAllowed(handle.address, allowedHandles)) {
    return rejected("sender-not-allowed");
  }
  if ((text ?? "").length > maxTextLength) return rejected("too-long");
  if (await seen.has(guid)) return rejected("duplicate");

  await seen.add(guid);
  return { status: "accepted", handle: handle.address, guid, text: text ?? "" };
}
