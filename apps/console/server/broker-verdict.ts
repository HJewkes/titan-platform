/**
 * The console's verdict writes to the agent-chat broker: `POST /api/queue/:msgId/{permission,endorse}`, gated by the UI token and
 * the `X-Owner-Channel: console` header so the broker can record which channel decided. Kept apart from `BrokerReader` so that
 * interface stays read-only, and from `BrokerAnswerer`, which answers chat_asks; both post through `brokerPost`.
 */
import { brokerPost, type BrokerOutcome, type BrokerPostOptions } from "./broker-post.js";

const QUEUE_ROUTE = "/api/queue";
const OWNER_CHANNEL = { "X-Owner-Channel": "console" };
/** agent-chat's own reasons for a verdict on an item that is no longer open or has no hook waiting. */
const CLOSED_REASON = /is not an open|no item with id|has no hook waiting/;

export type VerdictOutcome = BrokerOutcome;

export interface BrokerVerdicter {
  /** Never rejects: a broker that cannot be reached, redirects, or answers badly comes back as `unreachable`. */
  permission(msgId: string, behavior: "allow" | "deny"): Promise<VerdictOutcome>;
  /** `text` is the exact bytes the owner read; `to` is the recipient they read it addressed to. */
  endorse(msgId: string, text: string, to: string): Promise<VerdictOutcome>;
}

export function brokerVerdicter(options: BrokerPostOptions): BrokerVerdicter {
  const post = (msgId: string, verb: "permission" | "endorse", payload: unknown): Promise<VerdictOutcome> =>
    brokerPost(options, {
      route: `${QUEUE_ROUTE}/${encodeURIComponent(msgId)}/${verb}`,
      payload,
      headers: OWNER_CHANNEL,
      closedReason: CLOSED_REASON,
      refusedFallback: "not decided",
    });
  return {
    permission: (msgId, behavior) => post(msgId, "permission", { behavior }),
    endorse: (msgId, text, to) => post(msgId, "endorse", { text, to }),
  };
}
