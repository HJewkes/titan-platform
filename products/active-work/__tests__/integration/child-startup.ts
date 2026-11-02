/**
 * Startup diagnostics for tests that spawn the server through `tsx -e`.
 *
 * A child that dies at startup used to surface only as "never became healthy"
 * or "Connection closed", with its stderr written apart from the failure or
 * not read at all (TP-4478). These helpers keep that stderr and put it, with
 * the exit status, into the error the test fails with.
 */
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Stream } from 'node:stream';

const STDERR_TAIL_CHARS = 4_000;

/** Buffer a child's stderr, optionally echoing each chunk under `prefix`; read the tail with the returned function. */
export function captureStderr(stream: Stream | null | undefined, prefix?: string): () => string {
  let text = '';
  stream?.on('data', (chunk: Buffer) => {
    text += chunk.toString();
    if (prefix !== undefined) process.stderr.write(`${prefix} ${chunk.toString()}`);
  });
  return () => (text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text);
}

function exitStatus(child: ChildProcess): string | null {
  if (child.exitCode !== null) return `code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return null;
}

// 'exit' can fire before the last stderr chunk is read; a grandchild holding the pipe must not hang the test.
async function drained(child: ChildProcess): Promise<void> {
  const stream = child.stderr;
  if (stream === null || stream.closed) return;
  await Promise.race([once(stream, 'close'), new Promise((r) => setTimeout(r, 1_000))]);
}

/** Rethrow a failure with the child's stderr attached, so a dead server names its cause. */
export async function withStderr<T>(work: Promise<T>, stderr: () => string): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new Error(`${String(err)}; server stderr:\n${stderr() || '(empty)'}`, { cause: err });
  }
}

/**
 * Poll `/health` until it answers 2xx. Fails at once, naming the exit status
 * and stderr, if the child exits first; a timeout carries the stderr too.
 */
export async function waitForHealth(port: number, timeoutMs: number, child: ChildProcess, stderr: () => string): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    const status = exitStatus(child);
    if (status !== null) {
      await drained(child);
      throw new Error(`daemon exited (${status}) before /health answered on port ${port}; stderr:\n${stderr() || '(empty)'}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon never became healthy on port ${port}: ${String(lastErr)}; stderr:\n${stderr() || '(empty)'}`);
}
