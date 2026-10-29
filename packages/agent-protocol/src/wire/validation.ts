import { z } from "zod";

/** Refuses blank as well as absent: a stringified `undefined` once reached a peer as the word "undefined". */
export const nonBlank = (message: string) => z.string({ error: message }).refine((value) => value.trim() !== "", message);

export const requiredString = (field: string) => nonBlank(`${field} is required and must be a non-empty string`);

/** The refusal wording callers match on when an enum argument is out of range. */
export const oneOf = (field: string, allowed: readonly string[]) => ({ error: `${field} must be one of: ${allowed.join(", ")}` });

export const WORK_ROLES = ["implementer", "reviewer", "shepherd-review", "planner", "other"] as const;
const FIX_ROUND_ROLE = /^fix-round-[1-9]\d*$/;

/** One of `WORK_ROLES`, or `fix-round-<n>` for a shepherd's n-th fix round. */
export type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`;

export const isWorkRole = (value: string): value is WorkRole =>
  (WORK_ROLES as readonly string[]).includes(value) || FIX_ROUND_ROLE.test(value);

export const WORK_ROLE_CHOICES = `${WORK_ROLES.join(", ")}, fix-round-<n>`;
