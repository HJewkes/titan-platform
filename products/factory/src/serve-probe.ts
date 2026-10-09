const HEALTH_PATH = "/health";

/** Two attempts of `DEFAULT_SERVE_WAIT_MS / 2` each, so a busy serve gets the whole bound and one retry. */
const DEFAULT_SERVE_WAIT_MS = 20_000;

export type ServeProbe =
  | { state: "up"; health: Record<string, unknown> }
  | { state: "refused" }
  | { state: "slow"; waitedMs: number }
  | { state: "unready"; status: number };

type Attempt = ServeProbe | { state: "timeout" };

async function attempt(port: number, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: controller.signal });
    if (!res.ok) return { state: "unready", status: res.status };
    return { state: "up", health: (await res.json()) as Record<string, unknown> };
  } catch {
    return controller.signal.aborted ? { state: "timeout" } : { state: "refused" };
  } finally {
    clearTimeout(timer);
  }
}

/** Tells a refused connection (serve is down) from a connection that is open but unanswered (serve is busy). */
export async function probeServe(port: number, waitMs: number = DEFAULT_SERVE_WAIT_MS): Promise<ServeProbe> {
  const each = Math.max(1, Math.floor(waitMs / 2));
  for (let tries = 0; tries < 2; tries += 1) {
    const result = await attempt(port, each);
    if (result.state !== "timeout") return result;
  }
  return { state: "slow", waitedMs: each * 2 };
}
