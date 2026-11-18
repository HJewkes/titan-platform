import { z } from "zod";

const name = z.string().min(1);

const spawnEventSchema = z.object({ kind: z.literal("spawn"), agent: name });
const retireEventSchema = z.object({ kind: z.literal("retire"), agent: name });
const teleportEventSchema = z.object({ kind: z.literal("teleport"), successor: name.optional() });

// One claim per worktree, as chat_claim keeps it: an empty pattern list owns the whole worktree.
const claimEventSchema = z.object({
  kind: z.literal("claim"),
  owner: name,
  worktree: name,
  patterns: z.array(z.string()).default([]),
});
const releaseEventSchema = z.object({ kind: z.literal("release"), worktree: name });

const holdEventSchema = z.object({ kind: z.literal("hold"), target: name, reason: name });
const unholdEventSchema = z.object({ kind: z.literal("unhold"), target: name });

const backgroundEventSchema = z.object({
  kind: z.literal("background"),
  id: name,
  command: name,
  cwd: name,
});
const backgroundStopEventSchema = z.object({ kind: z.literal("background-stop"), id: name });

// The seat's own free text; a string, never trimmed or normalized.
const authoredEventSchema = z.object({ kind: z.literal("authored"), text: z.string() });

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
