/**
 * The shapes `rounds.list` and `rounds.get` answer with; `rounds.ts` reads the rounds dir into them and re-exports them.
 * A round's status is `statusOf`'s in `rounds.ts`, the one place it is derived.
 */
import { z } from "zod";
import type { Manifest } from "./round-schema.js";
import { gateAnswer } from "./round-answer.js";
import { priorFeedbackList } from "./prior-feedback.js";
import { roundNotes } from "./round-notes.js";
import { shipLineage } from "./ship-lineage.js";
import { roundLive } from "./storybook-build.js";

const roundStatus = z.enum(["open", "sent", "withdrawn"]);
export type RoundStatus = z.infer<typeof roundStatus>;

const roundHead = { id: z.string(), status: roundStatus, updatedAt: z.string().nullable() };

const invalidRound = z.object({ ...roundHead, valid: z.literal(false), reason: z.string() });

/** A withdrawn round's reason from its withdrawn.json, e.g. `superseded-by:<id>`; absent on an open or sent round. */
const withdrawnReason = { withdrawnReason: z.string().optional() };

export const roundSummary = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    unit: z.string(),
    round: z.number(),
    questions: z.number(),
    design: z.boolean(),
    ship: z.boolean(),
    /** Present when a pick-one offers a merge with no binding: it is answerable, but its answer taps no merge. */
    unbound: z.literal(true).optional(),
    recommendations: z.enum(["after-answer", "shown"]),
    ...withdrawnReason,
  }),
  invalidRound.extend(withdrawnReason),
]);

export const roundDetail = z.discriminatedUnion("valid", [
  z.object({
    ...roundHead,
    valid: z.literal(true),
    /** A round with frames and no merge-bound question is a design round, answered in the harness. */
    design: z.boolean(),
    /** A round with a merge-bound pick-one: the console shows its frames and answers it with Ship or Send back. */
    ship: z.boolean(),
    /** The sha256 of the round.json shown, which `rounds.submit` binds an answer to. */
    manifestSha256: z.string(),
    /** True while an after-answer round is unsent: every question's recommendation is stripped. */
    recommendationsWithheld: z.boolean(),
    /** While withheld, the questions that have a recommendation `rounds.reveal` can hand back; empty otherwise. */
    revealable: z.array(z.string()),
    /** Null unless the manifest's Storybook host is loopback. */
    storybookUrl: z.string().nullable(),
    manifest: z.custom<Manifest>(),
    answer: gateAnswer.optional(),
    /** A Ship round's proven head against its PR base now; absent on any other round. */
    lineage: shipLineage.optional(),
    /** A sent round's free text from its feedback.json; absent while unsent or when that file does not parse. */
    notes: roundNotes.optional(),
    /** An open or sent Ship round's earlier feedback on its unit, each to be ticked Addressed before Ship; absent when there is none. */
    priorFeedback: priorFeedbackList.optional(),
    /** A sent Ship round's side questions filed as follow-ups (TP-3346); absent when there are none. */
    followUps: z.array(z.string()).optional(),
    /** A round that carries a Storybook build: each story variant's url on the story origin, or why it shows its PNG (TP-3793). */
    live: roundLive.optional(),
  }),
  invalidRound,
]);

export type RoundSummary = z.infer<typeof roundSummary>;
export type RoundDetail = z.infer<typeof roundDetail>;
