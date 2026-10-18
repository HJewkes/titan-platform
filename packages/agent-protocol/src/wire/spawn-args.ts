import { z } from "zod";
import { ISOLATION_NAMES, SURFACE_NAMES } from "./names.js";

import { requiredString } from "./validation.js";

const WORK_ROLES = ['implementer', 'reviewer', 'shepherd-review', 'planner', 'other'] as const

type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`

const FIX_ROUND_ROLE = /^fix-round-[1-9]\d*$/

const isWorkRole = (value: string): value is WorkRole =>
  (WORK_ROLES as readonly string[]).includes(value) || FIX_ROUND_ROLE.test(value)

const WORK_ROLE_CHOICES = `${WORK_ROLES.join(', ')}, fix-round-<n>`

const oneOf = (field: string, allowed: readonly string[]) => ({
  error: `${field} must be one of: ${allowed.join(', ')}`,
})

const INHERIT_NAMES = ['context'] as const

const RETURN_CONTRACT_CHOICES = ['none'] as const

/** Captured legacy MCP input; socket field names remain a separate projection. */
export const AgentSpawnArgsSchema = z.object({
  name: requiredString('name').describe('Short handle for the agent, e.g. "auth-review". Must be free.'),
  profile: requiredString('profile').describe('Profile name; see agent_profiles for what each grants.'),
  brief: requiredString('brief').describe(
    'What the agent should do, in full. It starts with only this — it does not inherit your ' +
      'conversation, so state the task, the context needed to act, and what to report back.',
  ),
  surface: z
    .enum(SURFACE_NAMES, oneOf('surface', SURFACE_NAMES))
    .describe(
      "Overrides the profile's surface. Visible surfaces land in your window and can answer " +
        'permission prompts; headless cannot be prompted at all.',
    )
    .optional(),
  isolation: z
    .enum(ISOLATION_NAMES, oneOf('isolation', ISOLATION_NAMES))
    .describe(
      "Overrides the profile's isolation, e.g. worktree to keep it out of your checkout. Combined with " +
        'owns it is refused unless you also pass an assigned worktree. A new ' +
        "worktree branch is cut from a fresh fetch of origin's default branch, not your local HEAD.",
    )
    .optional(),
  cwd: z
    .string()
    .describe('Working directory. Defaults to the worktree when one is given, otherwise to yours.')
    .optional(),
  worktree: z
    .string()
    .describe(
      'Absolute path of a worktree the TASK SYSTEM already assigned to this work. Pass it when ' +
        'something upstream decided where this task runs, rather than ' +
        'letting the profile pick. It is ADOPTED, not created: it must already exist, no branch is ' +
        'made, no worktree-budget slot is taken, and retiring the agent leaves it in place, because ' +
        'siblings may still use it. Do not pass a path you invented; if nobody ' +
        'assigned a worktree, omit this and let the profile decide.',
    )
    .optional(),
  owns: z
    .array(z.string())
    .describe(
      'Path globs INSIDE the worktree that this agent owns, e.g. ["src/broker/**"]; refused when the ' +
        'agent would get its own worktree unless you also pass an assigned worktree.',
    )
    .optional(),
  inherit: z
    .enum(INHERIT_NAMES, oneOf('inherit', INHERIT_NAMES))
    .describe(
      'Set to "context" to start the agent from a COPY of YOUR OWN conversation instead of an ' +
        'empty one — the closest thing here to "fork me". It can only ever fork you: there is no ' +
        'field for whose conversation, and a request to fork a peer is refused. Reach for it when ' +
        'the agent needs what you have been doing and re-describing it would cost more than it is ' +
        'worth. KNOW WHAT IT IS NOT: still a separate process paying its own input tokens, so it ' +
        'is not the cheap built-in fork; and it sees only your COMPLETED turns, never the one you ' +
        'are in, so do not refer to work you have not finished narrating. Also weigh what it ' +
        'carries — the agent inherits everything you have said, including anything its profile was ' +
        'never meant to see. A brief is the narrower and usually better tool.',
    )
    .optional(),
  remote_control: z
    .boolean()
    .describe(
      'Start the agent with Claude Code Remote Control, so it can be driven from claude.ai or a ' +
        'phone. Explicit opt-in, default false: a spawned agent never gets it otherwise. Coordinator ' +
        'profiles only: it is refused for a worker profile. Headless surfaces ignore it, because a ' +
        'print-mode run cannot host Remote Control.',
    )
    .optional(),
  resume_session: z
    .string()
    .describe(
      "A Claude session uuid to CONTINUE instead of starting fresh, e.g. a retired agent's " +
        'session id from agent_list. Its transcript must already exist under the account ' +
        '(config_dir) and cwd the agent will run in; otherwise the spawn is refused and names the ' +
        "path it checked. A retired worktree agent's removed worktree is re-created at its old path " +
        'under the worktree budget, so pass isolation "worktree" and the repository as cwd. The brief ' +
        'becomes its next turn. For an agent that is finished but not retired, agent_resume is simpler.',
    )
    .optional(),
  predecessor: z
    .string()
    .describe(
      'Name of an agent YOU spawned whose work this one takes over, for a follow-up assignment ' +
        'sent to a fresh worker instead of the one that did the first piece. The broker adds a ' +
        "section to the brief with the predecessor's last report (its newest chat_send to you), " +
        'its branch and worktree, and its session id and transcript path, so the brief need only ' +
        'say what to do next. Refused for an agent someone else spawned. It does not retire the ' +
        'predecessor; retire it yourself once this one registers.',
    )
    .optional(),
  experiment: z
    .object({
      id: requiredString('experiment.id').describe('The experiment this spawn belongs to, e.g. "E3".'),
      arm: requiredString('experiment.arm').describe('The arm of that experiment this spawn runs.'),
    })
    .describe(
      'Optional experiment and arm, recorded on the spawn row so an arm table is one query over ' +
        'the log. Pass it only for a spawn that is part of a planned experiment.',
    )
    .optional(),
  return_contract: z
    .enum(RETURN_CONTRACT_CHOICES, oneOf('return_contract', RETURN_CONTRACT_CHOICES))
    .describe(
      'The broker appends its return contract (the report rules and format) to the brief of an ' +
        'implementer or reviewer profile you spawn, with your name filled in, so do not paste one. ' +
        'Pass "none" when this brief states a report format of its own, which the appended block ' +
        'would contradict. Omit it otherwise.',
    )
    .optional(),
  config_dir: z
    .string()
    .describe(
      'Absolute path of the Claude config dir the agent should run under, and therefore WHICH ' +
        'ACCOUNT it spends, e.g. "/Users/you/.claude-profiles/agents". Omit it in the ordinary ' +
        "case: the agent inherits YOUR account automatically, then the briefing initiative's " +
        "declared profile, then the broker's. Pass it only to bill an account deliberately. It " +
        'must already exist and be under your home directory; anything else is refused rather than ' +
        'quietly replaced, because running on the wrong account is the failure this prevents.',
    )
    .optional(),
  briefing: z
    .string()
    .describe(
      'Optional active-work initiative slug (e.g. "claude-channels"), or "auto". The broker reads ' +
        "that initiative's brief.md, open tasks and latest session note and prepends them to your " +
        'brief, so you do not have to re-describe the project — write the ASSIGNMENT in brief and ' +
        'let this carry the orientation. It also asks the active-work daemon for up to six notes, ' +
        'sources, tasks or sessions ranked against your brief text (any initiative, foreign ones ' +
        'labelled) and lists them with absolute paths; if the daemon does not answer within 1 second ' +
        'that list is left out and the spawn carries a warning. So the brief itself is the query: ' +
        'name the specifics. "auto" resolves from your own directory first, then from ' +
        'cwd; if neither is inside an initiative the spawn still succeeds, with a warning and no ' +
        'briefing. Omit it when the work has no active-work initiative behind it.',
    )
    .optional(),
  task: z
    .string()
    .describe(
      'The task id this agent works on, e.g. "CC-915". Recorded on the agent so its work can be ' +
        'traced back to the task; pass it whenever the work has one.',
    )
    .optional(),
  role: z
    .string()
    .refine(isWorkRole, { error: `role must be one of: ${WORK_ROLE_CHOICES}` })
    .describe(
      `What this agent does for the task: ${WORK_ROLE_CHOICES}. Omit it and the broker infers ` +
        'one from the profile and name, and marks it inferred.',
    )
    .optional(),
  override: z
    .literal('fix-round')
    .describe(
      'Set to "fix-round" when this spawn is a fix round on a task burndown has claimed or that is ' +
        'brief-ready; it passes the seat spawn gate, which otherwise warns or refuses.',
    )
    .optional(),
  host: z.string().describe('Machine alias or hostname to launch on; default: yours.').optional(),
});
export type AgentSpawnArgs = z.infer<typeof AgentSpawnArgsSchema>;
