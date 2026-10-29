import { z } from "zod";
import { ISOLATION_NAMES, SURFACE_NAMES } from "./names.js";
import { WORK_ROLE_CHOICES, isWorkRole, oneOf, requiredString } from "./validation.js";

const INHERIT_NAMES = ["context"] as const;
const RETURN_CONTRACT_CHOICES = ["none"] as const;

/**
 * `agent_spawn`'s MCP arguments, in the snake_case a model types. A plain object, so a key the tool
 * does not name is stripped rather than forwarded. Carries no `.describe()` text: the help is the
 * product's, written for its models, and the product adds it with `.extend()`.
 */
export const AgentSpawnArgsSchema = z.object({
  name: requiredString("name"),
  profile: requiredString("profile"),
  brief: requiredString("brief"),
  surface: z.enum(SURFACE_NAMES, oneOf("surface", SURFACE_NAMES)).optional(),
  isolation: z.enum(ISOLATION_NAMES, oneOf("isolation", ISOLATION_NAMES)).optional(),
  cwd: z.string().optional(),
  worktree: z.string().optional(),
  owns: z.array(z.string()).optional(),
  inherit: z.enum(INHERIT_NAMES, oneOf("inherit", INHERIT_NAMES)).optional(),
  remote_control: z.boolean().optional(),
  resume_session: z.string().optional(),
  predecessor: z.string().optional(),
  experiment: z.object({ id: requiredString("experiment.id"), arm: requiredString("experiment.arm") }).optional(),
  return_contract: z.enum(RETURN_CONTRACT_CHOICES, oneOf("return_contract", RETURN_CONTRACT_CHOICES)).optional(),
  config_dir: z.string().optional(),
  briefing: z.string().optional(),
  task: z.string().optional(),
  slice: z.string().optional(),
  route_override: z.string().optional(),
  role: z.string().refine(isWorkRole, { error: `role must be one of: ${WORK_ROLE_CHOICES}` }).optional(),
  override: z.literal("fix-round").optional(),
  host: z.string().optional(),
});

export type AgentSpawnArgs = z.output<typeof AgentSpawnArgsSchema>;
