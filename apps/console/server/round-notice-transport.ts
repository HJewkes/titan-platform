/**
 * How a round notice reaches a seat: the one seam between who is told (`round-asker.ts`, `round-subscriptions.ts`) and
 * how. Today it is `agent-chat debug send`, which delivers from the human seat, so a notice carries human provenance.
 * CC-1507 (an agent-chat console wake source) replaces `seatNotifier` here and nothing upstream of it changes.
 */
import { messageAgent } from "@titan-design/agent-dispatch";

/** agent-chat's peer name rule; an initiative slug follows the same shape. */
export const SEAT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Sends `text` to the live seat `seat`; rejects when it cannot be delivered. */
export type SeatNotifier = (seat: string, text: string) => Promise<void>;

const SEND_TIMEOUT_MS = 10_000;

/** `agent-chat debug send`, through agent-dispatch; a seat that is not live rejects, so the sweep tries again. */
export const seatNotifier =
  (agentChatBin: string): SeatNotifier =>
  (seat, text) =>
    messageAgent(agentChatBin, seat, text, SEND_TIMEOUT_MS);
