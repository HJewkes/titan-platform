import type {
  ButtonRow,
  ChannelCapabilities,
  EditInput,
  InteractionError,
  InteractionResult,
  InteractiveTransport,
  MediaFile,
  MediaSendResult,
  MessageRef,
  PhotoInput,
  Scheduler,
  SendError,
  SendInput,
  SendResult,
  VoiceInput,
} from "./contract.js";
import { emptyEditError, sendFailed } from "./contract.js";

export interface RecordedSend {
  handle: string;
  text: string;
  buttons?: ButtonRow[];
  at: number;
}

export type MockEvent =
  | { type: "send"; at: number; handle: string; text: string; buttons?: ButtonRow[]; ref: MessageRef }
  | { type: "react"; at: number; to: MessageRef; emoji: string | null }
  | { type: "chatAction"; at: number; handle: string; action: "typing" }
  | { type: "edit"; at: number; ref: MessageRef; text?: string; buttons?: ButtonRow[] | "remove" }
  | { type: "answer"; at: number; actionId: string; toast?: string }
  | { type: "sendVoice"; at: number; handle: string; audio: MediaFile; ref: MessageRef }
  | { type: "sendPhoto"; at: number; handle: string; image: MediaFile; caption?: string; ref: MessageRef };

export interface MockOptions {
  now?: () => number;
  capabilities?: Partial<ChannelCapabilities>;
}

export interface MockMessage {
  text: string;
  buttons?: ButtonRow[];
  reaction?: string;
}

/** What Telegram shows a typing action for, so `typingVisible` needs no real wait. */
export const MOCK_TYPING_VISIBLE_MS = 5000;

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  channel: "mock",
  canInitiate: true,
  deliveryCeiling: "accepted",
  buttons: true,
  buttonStates: false,
  edits: true,
  reactions: true,
  chatActions: true,
  drafts: false,
  draftStreaming: false,
  threads: false,
  media: true,
};

interface ScriptedFailure {
  error: InteractionError;
  on?: MockEvent["type"];
}

function keyOf(ref: MessageRef): string {
  return `${ref.channel}:${ref.chat}:${ref.messageId}`;
}

function sameButtons(left: ButtonRow[] | undefined, right: ButtonRow[] | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * In-memory transport for consumers that need to exercise retry, ceiling and
 * acknowledgement logic without an Apple ID, a second macOS user, or a
 * BlueBubbles server. It keeps every message it sent, so a later edit or
 * reaction has a target and a test can read what the person would see.
 */
export class MockTransport implements InteractiveTransport {
  readonly sent: RecordedSend[] = [];
  readonly log: MockEvent[] = [];
  readonly capabilities: ChannelCapabilities;
  private readonly now: () => number;
  private readonly scripted: ScriptedFailure[] = [];
  private readonly messages = new Map<string, MockMessage>();
  private readonly typingUntil = new Map<string, number>();
  private mediaSent = 0;

  /** The bare clock form is what 0.3.0 consumers pass, so it still works. */
  constructor(options: (() => number) | MockOptions = Date.now) {
    const resolved = typeof options === "function" ? { now: options } : options;
    this.now = resolved.now ?? Date.now;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...resolved.capabilities };
  }

  /** Queue one failure, optionally only for one method. Calls consume the queue in order. */
  failNext(error: InteractionError, on?: MockEvent["type"]): void {
    this.scripted.push({ error, ...(on ? { on } : {}) });
  }

  reset(): void {
    this.sent.length = 0;
    this.log.length = 0;
    this.scripted.length = 0;
    this.messages.clear();
    this.typingUntil.clear();
    this.mediaSent = 0;
  }

  messageAt(ref: MessageRef): MockMessage | undefined {
    return this.messages.get(keyOf(ref));
  }

  typingVisible(handle: string): boolean {
    const until = this.typingUntil.get(handle);
    return until !== undefined && this.now() < until;
  }

  /** An attempt is recorded even when it is scripted to fail. */
  async send({ handle, text, buttons }: SendInput): Promise<SendResult> {
    const at = this.now();
    this.sent.push({ handle, text, ...(buttons ? { buttons } : {}), at });
    const failure = this.take("send");
    if (failure) return sendFailed(asSendError(failure));

    const ref: MessageRef = { channel: "mock", chat: handle, messageId: `mock-${this.sent.length}` };
    this.messages.set(keyOf(ref), { text, ...(buttons ? { buttons } : {}) });
    this.typingUntil.delete(handle);
    this.log.push({ type: "send", at, handle, text, ...(buttons ? { buttons } : {}), ref });
    return { ok: true, messageGuid: ref.messageId, ref };
  }

  async react({ to, emoji }: { to: MessageRef; emoji: string | null }): Promise<InteractionResult> {
    const refused = this.refuse("react", "reactions");
    if (refused) return refused;

    const message = this.messages.get(keyOf(to));
    if (!message) return gone(to);
    if (emoji === null) delete message.reaction;
    else message.reaction = emoji;
    this.log.push({ type: "react", at: this.now(), to, emoji });
    return { ok: true, changed: true };
  }

  async chatAction({
    handle,
    action,
  }: {
    handle: string;
    action: "typing";
    threadId?: string;
  }): Promise<InteractionResult> {
    const refused = this.refuse("chatAction", "chatActions");
    if (refused) return refused;

    const at = this.now();
    this.typingUntil.set(handle, at + MOCK_TYPING_VISIBLE_MS);
    this.log.push({ type: "chatAction", at, handle, action });
    return { ok: true, changed: true };
  }

  async edit({ ref, text, buttons }: EditInput): Promise<InteractionResult> {
    const invalid = emptyEditError({ text, buttons });
    if (invalid) return { ok: false, error: invalid };

    const refused = this.refuse("edit", "edits");
    if (refused) return refused;

    const message = this.messages.get(keyOf(ref));
    if (!message) return gone(ref);
    const next = nextMessage(message, text, buttons);
    this.log.push({
      type: "edit",
      at: this.now(),
      ref,
      ...(text === undefined ? {} : { text }),
      ...(buttons === undefined ? {} : { buttons }),
    });
    if (next.text === message.text && sameButtons(next.buttons, message.buttons)) {
      return { ok: true, changed: false };
    }
    this.messages.set(keyOf(ref), { ...next, ...(message.reaction ? { reaction: message.reaction } : {}) });
    return { ok: true, changed: true };
  }

  async answerAction({
    actionId,
    toast,
  }: {
    actionId: string;
    toast?: string;
  }): Promise<InteractionResult> {
    const refused = this.refuse("answer", "buttons");
    if (refused) return refused;

    this.log.push({ type: "answer", at: this.now(), actionId, ...(toast === undefined ? {} : { toast }) });
    return { ok: true, changed: true };
  }

  /** Media goes to `log` only: `sent` and `messageAt` hold text a later edit can target. */
  async sendVoice({ handle, audio }: VoiceInput): Promise<MediaSendResult> {
    const refused = this.refuse("sendVoice", "media");
    if (refused) return refused;

    const ref = this.mediaRef(handle);
    this.log.push({ type: "sendVoice", at: this.now(), handle, audio, ref });
    return { ok: true, ref };
  }

  async sendPhoto({ handle, image, caption }: PhotoInput): Promise<MediaSendResult> {
    const refused = this.refuse("sendPhoto", "media");
    if (refused) return refused;

    const ref = this.mediaRef(handle);
    this.log.push({
      type: "sendPhoto",
      at: this.now(),
      handle,
      image,
      ...(caption === undefined ? {} : { caption }),
      ref,
    });
    return { ok: true, ref };
  }

  private mediaRef(handle: string): MessageRef {
    this.mediaSent += 1;
    this.typingUntil.delete(handle);
    return { channel: "mock", chat: handle, messageId: `mock-media-${this.mediaSent}` };
  }

  /** A capability turned off answers `unsupported` before any scripted failure is consumed. */
  private refuse(
    type: MockEvent["type"],
    capability: keyof ChannelCapabilities,
  ): { ok: false; error: InteractionError } | undefined {
    if (this.capabilities[capability] !== true) {
      return {
        ok: false,
        error: { kind: "unsupported", capability, message: `Mock channel has ${capability} off` },
      };
    }
    const failure = this.take(type);
    return failure ? { ok: false, error: failure } : undefined;
  }

  /** A failure scoped to one method is skipped by every other, so the queue stays in order. */
  private take(type: MockEvent["type"]): InteractionError | undefined {
    const index = this.scripted.findIndex((entry) => entry.on === undefined || entry.on === type);
    if (index < 0) return undefined;
    return this.scripted.splice(index, 1)[0]?.error;
  }
}

/** A send cannot report the two interaction-only kinds, so a mis-scoped script degrades. */
function asSendError(error: InteractionError): SendError {
  if (error.kind === "unsupported" || error.kind === "message-gone") {
    return { kind: "unknown", message: error.message };
  }
  return error;
}

function nextMessage(
  message: MockMessage,
  text: string | undefined,
  buttons: ButtonRow[] | "remove" | undefined,
): { text: string; buttons?: ButtonRow[] } {
  const nextButtons = buttons === undefined ? message.buttons : buttons === "remove" ? undefined : buttons;
  return { text: text ?? message.text, ...(nextButtons ? { buttons: nextButtons } : {}) };
}

function gone(ref: MessageRef): InteractionResult {
  return {
    ok: false,
    error: { kind: "message-gone", message: `No mock message at ${keyOf(ref)}` },
  };
}

/**
 * A `Scheduler` whose time only moves when a test moves it, so a keep-alive
 * loop is exercised in milliseconds rather than seconds.
 */
export class ManualClock implements Scheduler {
  private current: number;
  private waiters: { at: number; resolve: () => void }[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.current + ms, resolve });
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /** Awaiting the result lets whatever the sleepers do next run before the test asserts. */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.waiters.filter((waiter) => waiter.at <= this.current);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.current);
    for (const waiter of due) waiter.resolve();
    await Promise.resolve();
  }
}
