import { warn } from "./warnings.js";
import type { Allocation, IsolationContext, IsolationStrategy } from "./strategy.js";

/**
 * Isolation by capability: the agent stays in the shared checkout but carries a
 * narrower toolset.
 *
 * It restricts what an agent CAN DO, not where it collides. A read-only explorer
 * cannot conflict with anyone, which is a real and useful form of isolation, but
 * for an agent that writes this is not a substitute for `worktree`.
 *
 * And only `disallowedTools` removes a tool: `allowedTools` GRANTS, it does not
 * confine, because a spawned agent inherits the user's and project's settings
 * and those can grant anything the profile never mentioned.
 */

/**
 * What the agent is TOLD. Say only what is enforced, and say all of it.
 *
 * An agent believes its brief over a tool_result in its own context. A note
 * claiming a limit nobody enforces manufactures a confident false report; a note
 * listing only the profile's tools, while the launch also grants agent-chat's
 * own, made an explorer conclude it could not report back and stop without one
 * tool call. Understating costs what overstating does.
 */
const noteFor = (allowed: readonly string[], denied: readonly string[] | undefined): string => {
  // Named in prose rather than as the glob, which is what the agent actually
  // has to type. A glob in a sentence reads as a pattern to match, not a grant.
  const chat =
    " You also have agent-chat’s own tools (chat_send, chat_list and the rest); load them with" +
    " ToolSearch if they are not already listed, and use them to report back.";
  const limits = `Your tools are limited to: ${allowed.join(", ")}.`;
  const unavailable = denied?.length ? ` ${denied.join(", ")} are unavailable to you.` : "";
  return `${limits}${unavailable}${chat}`;
};

export const toolsetStrategy: IsolationStrategy = {
  name: "toolset-limited",

  async check(ctx: IsolationContext): Promise<string[]> {
    // Keyed on the DENY list, not the allow list: a non-empty allow list is
    // exactly as unconfined as an empty one.
    if (ctx.toolset?.disallowedTools?.length) return [];
    return [
      warn(
        "toolset-limited with no disallowedTools confines nothing: --allowed-tools grants " +
          "permission but does not remove a tool, and the agent still inherits user and project " +
          "settings that may allow more",
      ),
    ];
  },

  async allocate(ctx: IsolationContext): Promise<Allocation> {
    const { allowedTools, disallowedTools } = ctx.toolset ?? {};
    return {
      cwd: ctx.baseCwd,
      ...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
      ...(disallowedTools ? { disallowedTools: [...disallowedTools] } : {}),
      ...(allowedTools?.length ? { note: noteFor(allowedTools, disallowedTools) } : {}),
    };
  },

  async release(): Promise<boolean> {
    return true;
  },
};
