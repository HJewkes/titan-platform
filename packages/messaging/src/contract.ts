/**
 * The transport seam. Everything downstream of it (schedulers, protocol state
 * machines, composers) depends on this file and never on a vendor SDK.
 */

/** `data` comes back verbatim when the button is tapped; its format is the consumer's. */
export interface Button {
  label: string;
  data: string;
  /** Rendered only by a channel whose `buttonStates` is true; elsewhere it is ignored. */
  state?: "disabled";
  style?: "primary" | "success" | "danger";
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
 * `rate-limited` is its own case so a consumer backs off instead of re-deriving
 * "status 429 means retry"; `retryAfterSeconds` is absent when the server named
 * no wait, and the package never invents one.
 */
export type SendError =
  | { kind: "unreachable"; message: string }
  | { kind: "indeterminate"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "no-chat"; handle: string; message: string }
  | { kind: "too-long"; limit: number; length: number; message: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "rate-limited"; retryAfterSeconds?: number; message: string }
  | { kind: "bad-buttons"; message: string }
  | { kind: "unknown"; message: string };

export type ChannelId = "telegram" | "imessage" | "mock";

/**
 * Plain JSON. A product stores it as is and hands it back for an edit or a
 * reaction. It holds the resolved chat because a Telegram `messageId` is only
 * unique within one chat, so the pair is the identity and the key a message
 * store should use.
 */
export interface MessageRef {
  channel: ChannelId;
  chat: string;
  messageId: string;
  threadId?: string;
}

/**
 * `ok: true` means the server accepted the message for sending. There is no
 * delivered or read signal: those need the Private API, which is out of scope.
 * `ref` is absent when the server accepted the message without naming it.
 */
export type SendResult =
  | {
      ok: true;
      /** @deprecated Use `ref`. A bare id cannot address a Telegram message. */
      messageGuid?: string;
      ref?: MessageRef;
    }
  | { ok: false; error: SendError };

export interface MessageTransport {
  send(input: SendInput): Promise<SendResult>;
}

export function sendFailed(error: SendError): SendResult {
  return { ok: false, error };
}

/** The strongest signal the channel can ever report back about a sent message. */
export type DeliveryCeiling = "accepted" | "delivered" | "read";

/**
 * A static answer to "can this channel ever do this", so a caller picks a
 * degrade path before it calls. It never promises one call will succeed: a flag
 * is true only when the shipped adapter implements the thing today.
 */
export interface ChannelCapabilities {
  channel: ChannelId;
  maxTextLength?: number;
  /** Whether the bot can open a conversation with no prior message from the person. */
  canInitiate: boolean;
  deliveryCeiling: DeliveryCeiling;
  buttons: boolean;
  buttonStates: boolean;
  edits: boolean;
  reactions: boolean;
  chatActions: boolean;
  drafts: boolean;
  draftStreaming: boolean;
  threads: boolean;
}

/**
 * `unsupported` sits outside `SendError` so an exhaustive switch over send
 * failures breaks once for `rate-limited` and not twice.
 */
export type InteractionError =
  | SendError
  | { kind: "unsupported"; capability: keyof ChannelCapabilities; message: string }
  | { kind: "message-gone"; message: string };

/** `changed: false` is success: the message already read the way the caller asked for. */
export type InteractionResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: InteractionError };

export interface EditInput {
  ref: MessageRef;
  text?: string;
  buttons?: ButtonRow[] | "remove";
}

/**
 * The acknowledgement half of a channel, kept apart from `MessageTransport` so
 * a consumer's own one-method fake still satisfies the send contract. No method
 * here ever throws.
 */
export interface InteractiveTransport extends MessageTransport {
  readonly capabilities: ChannelCapabilities;
  react(input: { to: MessageRef; emoji: string | null }): Promise<InteractionResult>;
  chatAction(input: {
    handle: string;
    action: "typing";
    threadId?: string;
  }): Promise<InteractionResult>;
  edit(input: EditInput): Promise<InteractionResult>;
  answerAction(input: { actionId: string; toast?: string }): Promise<InteractionResult>;
}

/** Injected time, so a keep-alive loop is testable without a real wait. */
export interface Scheduler {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
