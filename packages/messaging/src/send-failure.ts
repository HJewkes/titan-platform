import type { SendError } from "./contract.js";

/**
 * Codes that only arise before a byte of the request is written: DNS lookup
 * and TCP connect. Anything else, including ECONNRESET, UND_ERR_SOCKET,
 * UND_ERR_HEADERS_TIMEOUT, ETIMEDOUT and an AbortError, can happen after the
 * server has the request, so it is not on this list.
 */
const NEVER_LEFT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const MAX_CAUSE_DEPTH = 4;

/** undici wraps the socket error as `TypeError("fetch failed")` with the coded error on `cause`. */
function firstErrorCode(thrown: unknown): string | undefined {
  let current = thrown;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    // DOMException carries a numeric legacy code, which says nothing about the wire.
    if (typeof code === "string") return code;
    current = cause;
  }
  return undefined;
}

/**
 * What a thrown `fetch` means for the message. Unknown shapes, which is every
 * Workers or Deno error, are indeterminate: calling a delivered message unsent
 * is what makes a retry loop double-send.
 */
export function classifyThrownSend(thrown: unknown): "unreachable" | "indeterminate" {
  const code = firstErrorCode(thrown);
  return code !== undefined && NEVER_LEFT_CODES.has(code) ? "unreachable" : "indeterminate";
}

export type FetchAttempt =
  | { sent: true; response: Response }
  | { sent: false; kind: "unreachable" | "indeterminate"; cause: unknown };

/** A throw from `prepare` (a bad base URL, say) happens before fetch is called, so nothing left. */
export async function attemptFetch(
  doFetch: typeof fetch,
  prepare: () => Parameters<typeof fetch>,
): Promise<FetchAttempt> {
  let request: Parameters<typeof fetch>;
  try {
    request = prepare();
  } catch (cause) {
    return { sent: false, kind: "unreachable", cause };
  }
  try {
    return { sent: true, response: await doFetch(...request) };
  } catch (cause) {
    return { sent: false, kind: classifyThrownSend(cause), cause };
  }
}

/** A 2xx means the server acted, so a body we cannot read is no proof it did not send. */
export function unreadableSuccess(status: number): SendError {
  return {
    kind: "indeterminate",
    message: `HTTP ${status} with a body that could not be read; the message may have been sent`,
  };
}
