import type { DeliveryStatus } from "./envelope.js";

/**
 * The reportable statuses, weakest first. `held` and `undeliverable` are
 * outcomes rather than progress, so they are not on this ladder and a cap never
 * rewrites them.
 */
const PROGRESS_LADDER: readonly DeliveryStatus[] = ["pending", "accepted", "delivered", "read"];

/**
 * Every transport titan speaks today — BlueBubbles without the private API,
 * the Telegram Bot API, the agent-chat bus — reports that the server took the
 * message and nothing after that.
 */
export const TRANSPORT_DELIVERY_CEILING: DeliveryStatus = "accepted";

/**
 * Clamp a claimed status to what the transport can actually observe. Without
 * this a consumer that optimistically writes `read` publishes a receipt no
 * transport ever sent.
 */
export function capDeliveryStatus(status: DeliveryStatus, ceiling: DeliveryStatus): DeliveryStatus {
  const claimed = PROGRESS_LADDER.indexOf(status);
  const limit = PROGRESS_LADDER.indexOf(ceiling);
  if (claimed < 0 || limit < 0) return status;
  return PROGRESS_LADDER[Math.min(claimed, limit)] ?? status;
}
