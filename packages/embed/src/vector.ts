export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch (${a.length} vs ${b.length})`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

/** Unit-length copy; the zero vector stays zero. */
export function normalize(v: readonly number[]): number[] {
  const n = norm(v);
  return n === 0 ? [...v] : v.map((x) => x / n);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/** Little-endian float32 bytes, the shape a cache_blob or sqlite-vec column stores. */
export function toFloat32Buffer(v: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

export function fromFloat32Buffer(buffer: Buffer): number[] {
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return [...new Float32Array(bytes)];
}
