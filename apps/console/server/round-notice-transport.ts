/**
 * How a round notice reaches a seat: the one seam between who is told (`round-asker.ts`, `round-subscriptions.ts`) and
 * how. It is `agent-chat debug send` with `--source console` (CC-1507): the notice arrives from the human seat but
 * labelled `wake_source=console`, with no human provenance marker, so a seat never reads it as the owner typing.
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
    messageAgent(agentChatBin, seat, text, SEND_TIMEOUT_MS, { source: "console" });
