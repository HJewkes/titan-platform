import { z } from "zod";
import { SURFACE_NAMES } from "./names.js";
import { requiredString } from "./validation.js";

/** MCP arguments for the agent tools other than spawn; plain objects, so unknown keys are stripped. */
export const AgentResumeArgsSchema = z.object({
  name: requiredString("name"),
  message: z.string().optional(),
  surface: z.enum(SURFACE_NAMES).optional(),
  /** The machine holding its transcript; resumes there. */
  host: z.string().optional(),
});

export const AgentSurfaceArgsSchema = z.object({ name: requiredString("name") });

/** `limit`'s default and cap are applied by the tool, so the published schema keeps it optional. */
export const AgentListArgsSchema = z.object({
  include_finished: z.boolean().optional(),
  include_retired: z.boolean().optional(),
  limit: z.number().optional(),
  mine: z.boolean().optional(),
  prefix: z.string().optional(),
  verbose: z.boolean().optional(),
});

export const AgentProfilesArgsSchema = z.object({
  name: z.string().optional(),
  verbose: z.boolean().optional(),
});

export type AgentResumeArgs = z.output<typeof AgentResumeArgsSchema>;
export type AgentSurfaceArgs = z.output<typeof AgentSurfaceArgsSchema>;
export type AgentListArgs = z.output<typeof AgentListArgsSchema>;
export type AgentProfilesArgs = z.output<typeof AgentProfilesArgsSchema>;
