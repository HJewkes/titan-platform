import type { ReviewSlots } from "./shepherd/review-slots.js";

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The reviewer-slot block from a `/health` answer; null when serve answered none, has read no roster yet, or predates the block. */
export function reviewSlotsOf(health: Record<string, unknown> | null): ReviewSlots | null {
  const block = health?.reviewSlots;
  if (typeof block !== "object" || block === null) return null;
  const { running, cap, readAt, rosterError } = block as Partial<ReviewSlots>;
  if (typeof cap !== "number" || typeof readAt !== "string") return null;
  if (typeof rosterError === "string") return { cap, readAt, rosterError };
  return isStrings(running) ? { running, cap, readAt } : null;
}

/** The human line `shepherd status` prints last; anything but a successful read says unread, never 0. */
export function reviewSlotsSummary(slots: ReviewSlots | null): string {
  if (slots === null) return "reviewers unread (no roster reading from titan-factory serve)\n";
  if (slots.running === undefined) return `reviewers unread (${slots.rosterError ?? "no roster reading"}, at ${slots.readAt})\n`;
  return `reviewers ${slots.running.length}/${slots.cap} (read ${slots.readAt})\n`;
}
