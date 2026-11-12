import { z } from "zod";
import { TRANSITIONAL_AGENT_VISIBLE } from "./visibility-transitional.js";

/** Who may read an initiative: only the owner, or agents too. A brief that says neither is owner-only. */
const INITIATIVE_VISIBILITIES = ["owner-only", "agent-visible"] as const;

export const InitiativeVisibilitySchema = z.enum(INITIATIVE_VISIBILITIES, {
  error: `visibility must be one of: ${INITIATIVE_VISIBILITIES.join(", ")}`,
});

export type InitiativeVisibility = z.infer<typeof InitiativeVisibilitySchema>;

const BriefVisibilitySchema = z.object({ visibility: InitiativeVisibilitySchema.optional() });

export interface InitiativeBriefRef {
  slug: string;
  /** The brief's parsed front matter, or null when brief.md is missing or its YAML does not parse. */
  brief: unknown;
}

const transitional: ReadonlySet<string> = new Set(TRANSITIONAL_AGENT_VISIBLE.initiatives);

/**
 * The one test every agent-facing reader applies. It fails closed: a missing or unparsable
 * brief, or a visibility value outside the closed set, is owner-only.
 */
export function isAgentVisible(initiative: InitiativeBriefRef): boolean {
  const parsed = BriefVisibilitySchema.safeParse(initiative.brief);
  if (!parsed.success) return false;
  const declared = parsed.data.visibility;
  if (declared !== undefined) return declared === "agent-visible";
  return transitional.has(initiative.slug);
}
