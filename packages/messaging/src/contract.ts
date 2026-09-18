/**
 * The transport seam. Everything downstream of it (schedulers, protocol state
 * machines, composers) depends on this file and never on a vendor SDK.
 */

/** `data` comes back verbatim when the button is tapped; its format is the consumer's. */
export interface Button {
  label: string;
  data: string;
}

export type ButtonRow = Button[];

/** The address iMessage routes to: a phone number or an email. */
export interface SendInput {
  handle: string;
  text: string;
  /** Channel-neutral rows of tappable buttons; a transport without them ignores this. */
  buttons?: ButtonRow[];
}

/**
 * Why a send did not happen. `no-chat` is its own case because iMessage cannot
 * open a conversation from an API call: a human has to send the first message.
 * `too-long` is its own case so a composer can split rather than retry.
 * `unreachable` means the request provably never left, so a retry cannot
 * duplicate it; `indeterminate` means it may have been delivered, so a retry can.
 */
export type SendError =
  | { kind: "unreachable"; message: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no-chat"; handle: string; message: string }
  | { kind: "too-long"; limit: number; length: number; message: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "bad-buttons"; message: string }
  | { kind: "unknown"; message: string };

/**
 * `ok: true` means the server accepted the message for sending. There is no
 * delivered or read signal: those need the Private API, which is out of scope.
 */
export type SendResult =
  | { ok: true; messageGuid?: string }
  | { ok: false; error: SendError };

export interface MessageTransport {
  send(input: SendInput): Promise<SendResult>;
}

export function sendFailed(error: SendError): SendResult {
  return { ok: false, error };
}
