import type {
  MessageTransport,
  SendError,
  SendInput,
  SendResult,
} from "./contract.js";
import { sendFailed } from "./contract.js";

export interface RecordedSend {
  handle: string;
  text: string;
  at: number;
}

/**
 * In-memory transport for consumers that need to exercise retry and ceiling
 * logic without an Apple ID, a second macOS user, or a BlueBubbles server.
 */
export class MockTransport implements MessageTransport {
  readonly sent: RecordedSend[] = [];
  private readonly scripted: SendError[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Queue one failure. Calls consume the queue in order, then succeed. */
  failNext(error: SendError): void {
    this.scripted.push(error);
  }

  reset(): void {
    this.sent.length = 0;
    this.scripted.length = 0;
  }

  /** An attempt is recorded even when it is scripted to fail. */
  async send({ handle, text }: SendInput): Promise<SendResult> {
    this.sent.push({ handle, text, at: this.now() });
    const failure = this.scripted.shift();
    if (failure) return sendFailed(failure);
    return { ok: true, messageGuid: `mock-${this.sent.length}` };
  }
}
