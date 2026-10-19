/**
 * The console's one write to the agent-chat broker: `POST /api/answer` for an open chat_ask, recorded by the broker under channel
 * `dashboard`. It is kept apart from `BrokerReader` so that interface stays read-only. The broker arbitrates every verdict, so a
 * question someone else answered first comes back as `closed`, not as an error. Its response shape is pinned here, not imported.
 */
import { CLIENT_HEADER } from "@titan-design/daemon";
import { z } from "zod";
import { readToken, TOKEN_HEADER } from "./broker.js";

const ANSWER_ROUTE = "/api/answer";
const TIMEOUT_MS = 5000;
/** agent-chat's own reasons for a verdict on an item that is no longer open (`core.answer`). */
const CLOSED_REASON = /is not an open item|no item with id/;

export type AnswerOutcome =
  | { status: "answered" }
  | { status: "closed"; reason: string }
  | { status: "refused"; reason: string; detail?: string }
  | { status: "unreachable"; detail: string };

export interface BrokerAnswerer {
  /** Never rejects: a broker that cannot be reached, redirects, or answers badly comes back as `unreachable`. */
  answer(msgId: string, text: string): Promise<AnswerOutcome>;
}

interface BrokerAnswererOptions {
  port: number;
  /** agent-chat's 0600 `ui.token`, re-read on every answer, as `BrokerReader` reads it. */
  tokenPath: string;
  fetch?: typeof fetch;
}

/** `VerdictResponse` on 200, `ErrorResponse` on a 4xx. */
const replyBody = z.looseObject({ ok: z.boolean().optional(), reason: z.string().optional(), error: z.string().optional() });

function outcomeOf(status: number, body: z.infer<typeof replyBody>): AnswerOutcome {
  if (status === 200 && body.ok === true) return { status: "answered" };
  if (status === 200 && body.ok === false) {
    const reason = body.reason ?? "not answered";
    return CLOSED_REASON.test(reason) ? { status: "closed", reason } : { status: "refused", reason };
  }
  if (status >= 400 && status < 500) return { status: "refused", reason: body.error ?? `broker answered ${status}` };
  return { status: "unreachable", detail: `agent-chat broker ${ANSWER_ROUTE} answered ${status}` };
}

export function brokerAnswerer(options: BrokerAnswererOptions): BrokerAnswerer {
  const doFetch = options.fetch ?? fetch;
  return {
    async answer(msgId, text) {
      try {
        const token = await readToken(options.tokenPath);
        // A followed redirect would carry the token header to wherever the Location points.
        const response = await doFetch(`http://127.0.0.1:${options.port}${ANSWER_ROUTE}`, {
          method: "POST",
          headers: { "content-type": "application/json", [TOKEN_HEADER]: token, [CLIENT_HEADER]: "titan-console" },
          body: JSON.stringify({ msgId, text, channel: "dashboard" }),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const parsed = replyBody.safeParse(await response.json().catch(() => ({})));
        return outcomeOf(response.status, parsed.success ? parsed.data : {});
      } catch (error) {
        return { status: "unreachable", detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
