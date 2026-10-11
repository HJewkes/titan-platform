import { z } from "zod";

const name = z.string().min(1);

export const spawnEventSchema = z.object({ kind: z.literal("spawn"), agent: name });
export const retireEventSchema = z.object({ kind: z.literal("retire"), agent: name });
export const teleportEventSchema = z.object({ kind: z.literal("teleport"), successor: name.optional() });

// One claim per worktree, as chat_claim keeps it: an empty pattern list owns the whole worktree.
export const claimEventSchema = z.object({
  kind: z.literal("claim"),
  owner: name,
  worktree: name,
  patterns: z.array(z.string()).default([]),
});
export const releaseEventSchema = z.object({ kind: z.literal("release"), worktree: name });

export const holdEventSchema = z.object({ kind: z.literal("hold"), target: name, reason: name });
export const unholdEventSchema = z.object({ kind: z.literal("unhold"), target: name });

export const backgroundEventSchema = z.object({
  kind: z.literal("background"),
  id: name,
  command: name,
  cwd: name,
});
export const backgroundStopEventSchema = z.object({ kind: z.literal("background-stop"), id: name });

// The seat's own free text; a string, never trimmed or normalized.
export const authoredEventSchema = z.object({ kind: z.literal("authored"), text: z.string() });

export const seatEventSchema = z.discriminatedUnion("kind", [
  spawnEventSchema,
  retireEventSchema,
  teleportEventSchema,
  claimEventSchema,
  releaseEventSchema,
  holdEventSchema,
  unholdEventSchema,
  backgroundEventSchema,
  backgroundStopEventSchema,
  authoredEventSchema,
]);

export const SEAT_EVENT_KINDS: readonly string[] = seatEventSchema.options.map((o) => o.shape.kind.value);

export type SeatEvent = z.infer<typeof seatEventSchema>;
