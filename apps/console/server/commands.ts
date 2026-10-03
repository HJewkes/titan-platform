import { z } from "zod";
import { defineCommand, type CommandMapOf } from "@titan-design/registry";
import { UPSTREAM_IDS, probeUpstreams, type Upstream } from "./upstreams.js";

const upstreamHealth = z.object({
  id: z.enum(UPSTREAM_IDS),
  label: z.string(),
  target: z.string(),
  reachable: z.boolean(),
  detail: z.string(),
});

/** Every command the console daemon serves, keyed by name so the browser's hooks can be typed from it. */
export function consoleCommands(upstreams: readonly Upstream[]) {
  return {
    "upstreams.health": defineCommand({
      name: "upstreams.health",
      description: "Reachability of the active-work daemon, the agent-chat broker and the session graph",
      args: z.object({}),
      result: z.object({ checkedAt: z.string(), upstreams: z.array(upstreamHealth) }),
      run: async () => ({ checkedAt: new Date().toISOString(), upstreams: await probeUpstreams(upstreams) }),
    }),
  };
}

export type ConsoleCommands = CommandMapOf<ReturnType<typeof consoleCommands>>;
