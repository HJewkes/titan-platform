import { parseBase64Secret, trackSecretFile } from "@titan-design/daemon";
import type { WebhookSecret } from "./answer.js";

/** `unread` until the first delivery past the kill switch: health never reads the file itself. */
export type WebhookSecretState = "unread" | "present" | "missing" | "refused";

export interface TrackedWebhookSecret {
  read: WebhookSecret;
  /** What the last read found. */
  state(): WebhookSecretState;
}

/**
 * Opened lazily so a missing file at serve start is not an error, then re-read on change so a rotation needs no restart.
 * The base64url parser takes `openssl rand -hex 32` output: hex digits are base64url, and 64 of them decode to 48 bytes.
 */
export function trackWebhookSecret(file: string): TrackedWebhookSecret {
  let tracked: (() => string) | undefined;
  let state: WebhookSecretState = "unread";
  const read = (): string => {
    try {
      tracked ??= trackSecretFile(file, parseBase64Secret);
      const secret = tracked();
      state = "present";
      return secret;
    } catch (error) {
      state = error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "refused";
      throw error;
    }
  };
  return { read, state: () => state };
}
