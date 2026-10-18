import { z } from "zod";
import { SURFACE_NAMES } from "./names.js";
import { requiredString } from "./validation.js";

/** Exact legacy MCP argument projection; not a socket request. */
export const AgentResumeArgsSchema = z.object({
    name: requiredString('name').describe('The agent to resume, as shown by agent_list.'),
    message: z
      .string()
      .optional()
      .describe(
        'The turn it resumes on: what to do next. Omit for a generic "check your inbox and continue".',
      ),
    surface: z
      .enum(SURFACE_NAMES)
      .optional()
      .describe(
        'Where it comes back. Defaults to headless; a visible surface opens a pane and drops message.',
      ),
  });
export type AgentResumeArgs = z.infer<typeof AgentResumeArgsSchema>;

/** Exact legacy MCP argument projection; not a socket request. */
export const AgentListArgsSchema = z.object({
    include_retired: z
      .boolean()
      .describe('Also list retired agents, with the session id agent_spawn resume_session needs.')
      .optional(),
    mine: z.boolean().describe('Only agents this session spawned.').optional(),
    prefix: z.string().describe('Only agents whose name starts with this.').optional(),
  });
export type AgentListArgs = z.infer<typeof AgentListArgsSchema>;

/** Exact legacy MCP argument projection; not a socket request. */
export const AgentSurfaceArgsSchema = z.object({
    name: requiredString('name').describe('The headless agent to bring up, as shown by agent_list.'),
  });
export type AgentSurfaceArgs = z.infer<typeof AgentSurfaceArgsSchema>;

/** Exact legacy MCP argument projection; not a socket request. */
export const AgentProfilesArgsSchema = z.object({ name: z.string().optional().describe('Return only this profile.') });
export type AgentProfilesArgs = z.infer<typeof AgentProfilesArgsSchema>;

/** These legacy MCP commands return formatted text, not new JSON socket frames. */
export const AgentToolTextResultSchema = z.string();
