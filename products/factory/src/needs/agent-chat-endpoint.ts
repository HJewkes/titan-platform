import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrokerEndpoint } from "./agent-chat-source.js";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The local broker as agent-chat records it: the port in `broker.meta.json` and the 0600 `ui.token`, both under AGENT_CHAT_HOME. */
export function localBrokerEndpoint(env: NodeJS.ProcessEnv): BrokerEndpoint {
  const home = env.AGENT_CHAT_HOME ?? join(homedir(), ".agent-chat");
  return {
    baseUrl: () => {
      try {
        const port: unknown = JSON.parse(readOrNull(join(home, "broker.meta.json")) ?? "{}").port;
        return typeof port === "number" ? `http://127.0.0.1:${port}` : null;
      } catch {
        return null;
      }
    },
    token: () => readOrNull(join(home, "ui.token"))?.trim() || null,
  };
}
