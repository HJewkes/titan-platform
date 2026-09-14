import type { ProbeOptions } from "./liveness.js";
import { fetchWithTimeout } from "./liveness.js";
import type { TelegramConfig } from "./telegram.js";
import { methodUrl, readEnvelope } from "./telegram.js";

export type TelegramLiveness =
  | { state: "alive"; username?: string; botId?: number }
  | {
      state: "dark";
      reason: "unreachable" | "unauthorized" | "timeout" | "bad-response";
    };

function readBot(result: unknown): TelegramLiveness {
  const user = result as { id?: unknown; username?: unknown } | null;
  if (!user || typeof user !== "object") {
    return { state: "dark", reason: "bad-response" };
  }
  return {
    state: "alive",
    username: typeof user.username === "string" ? user.username : undefined,
    botId: typeof user.id === "number" ? user.id : undefined,
  };
}

async function readAlive(response: Response): Promise<TelegramLiveness> {
  if (response.status === 401) return { state: "dark", reason: "unauthorized" };
  const envelope = await readEnvelope(response);
  if (!response.ok || !envelope.ok) {
    return { state: "dark", reason: "bad-response" };
  }
  return readBot(envelope.result);
}

function darkReason(cause: unknown): TelegramLiveness {
  const aborted = cause instanceof Error && cause.name.endsWith("AbortError");
  return { state: "dark", reason: aborted ? "timeout" : "unreachable" };
}

/**
 * getMe is the documented way to test a token, so it doubles as the heartbeat:
 * it says both "the API answers" and "this token still works".
 */
export async function probeTelegramLiveness(
  config: TelegramConfig,
  { timeoutMs }: ProbeOptions,
): Promise<TelegramLiveness> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const outcome = await fetchWithTimeout(
    doFetch,
    methodUrl(config, "getMe"),
    timeoutMs,
  );
  if (outcome.kind === "timeout") return { state: "dark", reason: "timeout" };
  if (outcome.kind === "error") return darkReason(outcome.cause);
  return await readAlive(outcome.response);
}
