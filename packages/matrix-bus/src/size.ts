// The server rejects a PDU over 65,535 bytes; the envelope around content needs the headroom.
export const MAX_CONTENT_BYTES = 60_000;

export class ContentTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`event content is ${bytes} bytes, over the ${MAX_CONTENT_BYTES}-byte limit`);
    this.name = "ContentTooLargeError";
  }
}

export function contentBytes(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}

export function assertSendable(content: unknown): void {
  const bytes = contentBytes(content);
  if (bytes > MAX_CONTENT_BYTES) throw new ContentTooLargeError(bytes);
}
