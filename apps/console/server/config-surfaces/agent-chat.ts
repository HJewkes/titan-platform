import path from "node:path";
import { AGENT_CHAT_CONFIG_SURFACE, PROFILE_SURFACE, joinSurfaces, type SurfaceReader } from "./catalog.js";
import { jsonTargets, readTarget } from "./files.js";

/**
 * agent-chat's `config.json` machine limits and every `profiles/*.json` on this host. The broker's
 * token files and `private-denylist.json` sit beside them and are never named as targets.
 */
export function agentChatSurfaces(agentChatDir: string): SurfaceReader {
  return async () => {
    const profiles = await jsonTargets(path.join(agentChatDir, "profiles"), PROFILE_SURFACE, "profile");
    const targets = [{ spec: AGENT_CHAT_CONFIG_SURFACE, surface: "agent-chat-config", file: path.join(agentChatDir, "config.json") }, ...profiles.targets];
    const answer = joinSurfaces(await Promise.all(targets.map((target) => readTarget(target))));
    return { ...answer, gaps: [...profiles.gaps, ...answer.gaps] };
  };
}
