import type { UpstreamSample } from "./recorder.js";

const RPC_PREFIX = "/rpc/";

export interface UpstreamObserver {
  recordUpstream(sample: UpstreamSample): void;
}

type Outcome = UpstreamSample["outcome"];

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a caller's own abort says `AbortError`. Both are a call that ran out of time. */
function outcomeOfFailure(err: unknown): Outcome {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
}

/** The command from the RPC path only: the body, the query and any id stay out of the name. */
function commandOf(input: Parameters<typeof fetch>[0]): string {
  const raw = input instanceof Request ? input.url : String(input);
  const pathname = new URL(raw, "http://upstream.invalid").pathname;
  return pathname.startsWith(RPC_PREFIX) ? decodeURIComponent(pathname.slice(RPC_PREFIX.length)) : "(other)";
}

function observe(recorder: UpstreamObserver | undefined, sample: UpstreamSample): void {
  try {
    recorder?.recordUpstream(sample);
  } catch {
    // telemetry never fails a call
  }
}

async function bodyBytes(response: Response): Promise<number> {
  try {
    return (await response.clone().arrayBuffer()).byteLength;
  } catch {
    return 0;
  }
}

/** Times each call to `upstream` and records it once the body has arrived; the caller gets the response or the failure unchanged. */
export function timedFetch(upstream: string, recorder: UpstreamObserver | undefined, inner: typeof fetch): typeof fetch {
  if (recorder === undefined) return inner;
  return async (input, init) => {
    const name = `${upstream}:${commandOf(input)}`;
    const started = performance.now();
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      observe(recorder, { name, ms: performance.now() - started, bytes: 0, outcome: outcomeOfFailure(err) });
      throw err;
    }
    void bodyBytes(response).then((bytes) => {
      observe(recorder, { name, ms: performance.now() - started, bytes, outcome: response.ok ? "ok" : "error" });
    });
    return response;
  };
}
