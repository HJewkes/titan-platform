/** Streams opened without an encoding yield Buffers; anything else is a bug worth failing loudly on. */
export function asBuffer(chunk: unknown): Buffer {
  if (!Buffer.isBuffer(chunk)) throw new TypeError("expected a Buffer chunk from a byte stream");
  return chunk;
}
