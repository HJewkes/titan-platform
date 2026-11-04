/**
 * The console's verdict writes to the agent-chat broker: `POST /api/queue/:msgId/{permission,endorse}`, gated by the UI token and
 * the `X-Owner-Channel: console` header so the broker can record which channel decided. Kept apart from `BrokerReader` so that
 * interface stays read-only, and from `BrokerAnswerer`, which answers chat_asks. The broker arbitrates every verdict, so a prompt
 * someone else decided first comes back as `closed`, not as an error. Its response shape is pinned here, not imported.
 */
import { CLIENT_HEADER } from "@titan-design/daemon";
import { z } from "zod";
import { readToken, TOKEN_HEADER } from "./broker.js";

const QUEUE_ROUTE = "/api/queue";
const OWNER_CHANNEL_HEADER = "X-Owner-Channel";
const TIMEOUT_MS = 5000;
/** agent-chat's own reasons for a verdict on an item that is no longer open or has no hook waiting. */
const CLOSED_REASON = /is not an open|no item with id|has no hook waiting/;

export type VerdictOutcome =
  | { status: "answered" }
  | { status: "closed"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "unreachable"; detail: string };

export interface BrokerVerdicter {
  /** Never rejects: a broker that cannot be reached, redirects, or answers badly comes back as `unreachable`. */
  permission(msgId: string, behavior: "allow" | "deny"): Promise<VerdictOutcome>;
  /** `text` is the exact bytes the owner read; `to` is the recipient they read it addressed to. */
  endorse(msgId: string, text: string, to: string): Promise<VerdictOutcome>;
}

interface BrokerVerdicterOptions {
  port: number;
  /** agent-chat's 0600 `ui.token`, re-read on every verdict, as `BrokerReader` reads it. */
  tokenPath: string;
  fetch?: typeof fetch;
}

/** `VerdictResponse` on 200, `ErrorResponse` on a 4xx. */
const replyBody = z.looseObject({ ok: z.boolean().optional(), reason: z.string().optional(), error: z.string().optional() });

function outcomeOf(status: number, body: z.infer<typeof replyBody>, route: string): VerdictOutcome {
  if (status === 200 && body.ok === true) return { status: "answered" };
  if (status === 200 && body.ok === false) {
    const reason = body.reason ?? "not decided";
    return CLOSED_REASON.test(reason) ? { status: "closed", reason } : { status: "refused", reason };
  }
  // A 404 means a broker that has not deployed the verdict routes yet; it is a refusal, not an outage.
  if (status >= 400 && status < 500) return { status: "refused", reason: body.error ?? `broker answered ${status}` };
  return { status: "unreachable", detail: `agent-chat broker ${route} answered ${status}` };
}

/** The outcome reaches the owner's browser; a broker or transport error that echoes the token must not carry it there. */
function redacted(outcome: VerdictOutcome, token: string): VerdictOutcome {
  if (token === "") return outcome;
  const scrub = (text: string): string => text.split(token).join("[token]");
  if (outcome.status === "closed" || outcome.status === "refused") return { ...outcome, reason: scrub(outcome.reason) };
  if (outcome.status === "unreachable") return { ...outcome, detail: scrub(outcome.detail) };
  return outcome;
}

export function brokerVerdicter(options: BrokerVerdicterOptions): BrokerVerdicter {
  const doFetch = options.fetch ?? fetch;

  async function post(msgId: string, verb: "permission" | "endorse", payload: unknown): Promise<VerdictOutcome> {
    const route = `${QUEUE_ROUTE}/${encodeURIComponent(msgId)}/${verb}`;
    let token = "";
    try {
      token = await readToken(options.tokenPath);
      // A followed redirect would carry the token header to wherever the Location points.
      const response = await doFetch(`http://127.0.0.1:${options.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: token, [OWNER_CHANNEL_HEADER]: "console", [CLIENT_HEADER]: "titan-console" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const parsed = replyBody.safeParse(await response.json().catch(() => ({})));
      return redacted(outcomeOf(response.status, parsed.success ? parsed.data : {}, route), token);
    } catch (error) {
      return redacted({ status: "unreachable", detail: error instanceof Error ? error.message : String(error) }, token);
    }
  }

  return {
    permission: (msgId, behavior) => post(msgId, "permission", { behavior }),
    endorse: (msgId, text, to) => post(msgId, "endorse", { text, to }),
  };
}
