/**
 * The console's one client for writes to the agent-chat broker. `BrokerAnswerer` and `BrokerVerdicter` both post through it, so
 * the token read, the no-redirect fetch, the pinned reply shape and the token redaction exist once. The broker arbitrates every
 * verdict, so an item someone else settled first comes back as `closed`, not as an error.
 */
import { CLIENT_HEADER } from "@titan-design/daemon";
import { z } from "zod";
import { readToken, TOKEN_HEADER } from "./broker.js";

const TIMEOUT_MS = 5000;

export type BrokerOutcome =
  | { status: "answered" }
  | { status: "closed"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "unreachable"; detail: string };

export interface BrokerPostOptions {
  port: number;
  /** agent-chat's 0600 `ui.token`, re-read on every post, as `BrokerReader` reads it. */
  tokenPath: string;
  fetch?: typeof fetch;
}

interface BrokerPostRequest {
  route: string;
  payload: unknown;
  /** Headers beyond the token, content type and client name. */
  headers?: Record<string, string>;
  /** agent-chat's own reasons for a verdict on an item that is no longer open. */
  closedReason: RegExp;
  /** The reason used when a 200 refusal carries none. */
  refusedFallback: string;
}

/** `VerdictResponse` on 200, `ErrorResponse` on a 4xx. */
const replyBody = z.looseObject({ ok: z.boolean().optional(), reason: z.string().optional(), error: z.string().optional() });

function outcomeOf(status: number, body: z.infer<typeof replyBody>, request: BrokerPostRequest): BrokerOutcome {
  if (status === 200 && body.ok === true) return { status: "answered" };
  if (status === 200 && body.ok === false) {
    const reason = body.reason ?? request.refusedFallback;
    return request.closedReason.test(reason) ? { status: "closed", reason } : { status: "refused", reason };
  }
  // A 404 means a broker that has not deployed the route yet; it is a refusal, not an outage.
  if (status >= 400 && status < 500) return { status: "refused", reason: body.error ?? `broker answered ${status}` };
  return { status: "unreachable", detail: `agent-chat broker ${request.route} answered ${status}` };
}

/** The outcome reaches the owner's browser; a broker or transport error that echoes the token must not carry it there. */
function redacted(outcome: BrokerOutcome, token: string): BrokerOutcome {
  if (token === "") return outcome;
  const scrub = (text: string): string => text.split(token).join("[token]");
  if (outcome.status === "closed" || outcome.status === "refused") return { ...outcome, reason: scrub(outcome.reason) };
  if (outcome.status === "unreachable") return { ...outcome, detail: scrub(outcome.detail) };
  return outcome;
}

/** Never rejects: a broker that cannot be reached, redirects, or answers badly comes back as `unreachable`. */
export async function brokerPost(options: BrokerPostOptions, request: BrokerPostRequest): Promise<BrokerOutcome> {
  const doFetch = options.fetch ?? fetch;
  let token = "";
  try {
    token = await readToken(options.tokenPath);
    // A followed redirect would carry the token header to wherever the Location points.
    const response = await doFetch(`http://127.0.0.1:${options.port}${request.route}`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token, ...request.headers, [CLIENT_HEADER]: "titan-console" },
      body: JSON.stringify(request.payload),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed = replyBody.safeParse(await response.json().catch(() => ({})));
    return redacted(outcomeOf(response.status, parsed.success ? parsed.data : {}, request), token);
  } catch (error) {
    return redacted({ status: "unreachable", detail: error instanceof Error ? error.message : String(error) }, token);
  }
}
