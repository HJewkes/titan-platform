import { z } from "zod";

export const MAX_QUOTE_WORDS = 25;

export const EVENTS = ["won", "referenced", "lost", "preview", "other"] as const;

export const CandidateSchema = z.object({
  id: z.string(),
  quote: z.string(),
  entity: z.string(),
  subject: z.string(),
  period: z.string().optional(),
  event: z.enum(EVENTS),
  names: z.array(z.string()),
});

export const ScreenVerdictSchema = z.object({
  judged: z.array(z.string()),
  candidates: z.array(CandidateSchema),
});

export const ConfirmRowSchema = z.object({
  id: z.string(),
  entity: z.string(),
  subject: z.string(),
  period: z.string(),
  detail: z.string(),
  role: z.string(),
  quote: z.string(),
  event: z.enum(EVENTS),
  confidence: z.enum(["sure", "unsure"]),
  reason: z.string(),
});

export const ConfirmVerdictSchema = z.object({
  judged: z.array(z.string()),
  rows: z.array(ConfirmRowSchema),
});

export type Candidate = z.infer<typeof CandidateSchema>;
export type ScreenVerdict = z.infer<typeof ScreenVerdictSchema>;
export type ConfirmRow = z.infer<typeof ConfirmRowSchema>;
export type ConfirmVerdict = z.infer<typeof ConfirmVerdictSchema>;
