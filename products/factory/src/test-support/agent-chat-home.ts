import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * Gives agent-dispatch's profile guard a home under `home` that holds each of `profiles` as headless, and returns its
 * profiles dir. Stubbing HOME alone is not enough: the guard prefers `$AGENT_CHAT_HOME/profiles`, and agent-chat
 * forwards AGENT_CHAT_HOME into every agent it spawns, so a test run by an agent read the host's profiles (TP-2891).
 * The caller undoes both stubs with `vi.unstubAllEnvs()`.
 */
export function isolateAgentChatHome(home: string, profiles: readonly string[]): string {
  const agentChatHome = join(home, ".agent-chat");
  const profilesDir = join(agentChatHome, "profiles");
  mkdirSync(profilesDir, { recursive: true });
  for (const profile of profiles) writeFileSync(join(profilesDir, `${profile}.json`), JSON.stringify({ surface: "headless" }));
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENT_CHAT_HOME", agentChatHome);
  return profilesDir;
}
