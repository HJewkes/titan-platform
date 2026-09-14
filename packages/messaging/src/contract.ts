/**
 * The transport seam. Everything downstream of it (schedulers, protocol state
 * machines, composers) depends on this file and never on a vendor SDK.
 */

/** The address iMessage routes to: a phone number or an email. */
export interface SendInput {
  handle: string;
  text: string;
}

/**
 * Why a send did not happen. `no-chat` is its own case because iMessage cannot
 * open a conversation from an API call: a human has to send the first message.
 */
export type SendError =
  | { kind: "unreachable"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no-chat"; handle: string; message: string }
  | { kind: "rejected"; status: number; message: string }
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
