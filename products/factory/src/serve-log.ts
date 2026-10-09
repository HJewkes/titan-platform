type ConsoleWrite = (...args: unknown[]) => void;

/**
 * Prefixes every `console.error` and `console.warn` line with its ISO time and returns the restore.
 * Patching the console, not the logger, also stamps the shepherd modules that call `console.warn` directly.
 */
export function timestampConsole(now: () => Date = () => new Date()): () => void {
  const { error, warn } = console;
  const stamped = (write: ConsoleWrite): ConsoleWrite => (first?: unknown, ...rest: unknown[]) => {
    const at = now().toISOString();
    if (typeof first === "string") write(`${at} ${first}`, ...rest);
    else write(at, first, ...rest);
  };
  console.error = stamped(error);
  console.warn = stamped(warn);
  return () => {
    console.error = error;
    console.warn = warn;
  };
}
