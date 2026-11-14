/**
 * The console's answer to an open chat_ask: `POST /api/answer`, recorded by the broker under channel `dashboard`. It is kept apart
 * from `BrokerReader` so that interface stays read-only, and posts through `brokerPost`, the one client that redacts the token.
 */
import { brokerPost, type BrokerOutcome, type BrokerPostOptions } from "./broker-post.js";

/** agent-chat's own reasons for a verdict on an item that is no longer open (`core.answer`). */
const CLOSED_REASON = /is not an open item|no item with id/;

export type AnswerOutcome = BrokerOutcome;

export interface BrokerAnswerer {
  /** Never rejects: a broker that cannot be reached, redirects, or answers badly comes back as `unreachable`. */
  answer(msgId: string, text: string): Promise<AnswerOutcome>;
}

export function brokerAnswerer(options: BrokerPostOptions): BrokerAnswerer {
  return {
    answer: (msgId, text) =>
      brokerPost(options, { route: "/api/answer", payload: { msgId, text, channel: "dashboard" }, closedReason: CLOSED_REASON, refusedFallback: "not answered" }),
  };
}
