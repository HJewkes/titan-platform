import type { BlueBubblesConfig } from "./bluebubbles.js";
import { apiUrl } from "./bluebubbles.js";

const INFO_PATH = "/api/v1/server/info";

export type Liveness =
  | {
      state: "alive";
      serverVersion?: string;
      osVersion?: string;
      privateApi?: boolean;
    }
  | {
      state: "dark";
      reason: "unreachable" | "unauthorized" | "timeout" | "bad-response";
    };

export interface ProbeOptions {
  timeoutMs: number;
}

type Outcome =
  | { kind: "response"; response: Response }
  | { kind: "timeout" }
  | { kind: "error"; cause: unknown };

/** Races the request so an injected fetch that ignores the signal still times out. */
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Outcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const request = doFetch(url, { signal: controller.signal }).then(
    (response): Outcome => ({ kind: "response", response }),
    (cause): Outcome => ({ kind: "error", cause }),
  );
  try {
    return await Promise.race([request, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function readInfo(body: unknown): Liveness {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") {
    return { state: "dark", reason: "bad-response" };
  }
  const version = data.server_version;
  const os = data.os_version;
  return {
    state: "alive",
    serverVersion: typeof version === "string" ? version : undefined,
    osVersion: typeof os === "string" ? os : undefined,
    privateApi:
      typeof data.private_api === "boolean" ? data.private_api : undefined,
  };
}

function darkReason(cause: unknown): Liveness {
  const aborted = cause instanceof Error && cause.name.endsWith("AbortError");
  return { state: "dark", reason: aborted ? "timeout" : "unreachable" };
}

async function readAlive(response: Response): Promise<Liveness> {
  if (response.status === 401 || response.status === 403) {
    return { state: "dark", reason: "unauthorized" };
  }
  if (!response.ok) return { state: "dark", reason: "bad-response" };
  try {
    return readInfo(await response.json());
  } catch {
    return { state: "dark", reason: "bad-response" };
  }
}

/**
 * The heartbeat every consumer runs before sending. macOS auto-logs in one user
 * at boot, so after a reboot the coach session is dark until a human switches
 * into it: `dark` is an expected state, not an exception.
 */
export async function probeLiveness(
  config: BlueBubblesConfig,
  { timeoutMs }: ProbeOptions,
): Promise<Liveness> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const outcome = await fetchWithTimeout(
    doFetch,
    apiUrl(config, INFO_PATH),
    timeoutMs,
  );
  if (outcome.kind === "timeout") return { state: "dark", reason: "timeout" };
  if (outcome.kind === "error") return darkReason(outcome.cause);
  return await readAlive(outcome.response);
}
