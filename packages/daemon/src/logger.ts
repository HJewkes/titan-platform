/**
 * The logging surface the daemon needs, expressed as a parameter rather than a
 * dependency. The shape is pino's `(fields, message)` call signature, so a pino instance
 * satisfies it structurally and a product can pass its own logger instead.
 */
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

function write(level: string, fields: Record<string, unknown>, message: string): void {
  const detail = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields, replaceErrors)}` : "";
  console.error(`[${level}] ${message}${detail}`);
}

function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/** Default logger: one line per record on stderr, so stdout stays clean for stdio MCP. */
export const consoleLogger: Logger = {
  info: (fields, message) => write("info", fields, message),
  warn: (fields, message) => write("warn", fields, message),
  error: (fields, message) => write("error", fields, message),
};

/** Drops every record. Useful in tests and for products that log elsewhere. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
