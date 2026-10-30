/** C0 (newline and ESC included), DEL and C1: a terminal acts on these instead of printing them. */
const isControl = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/**
 * Agent names, tasks, models and error text come from other processes; an ESC in one could
 * repaint or retitle the owner's terminal. They are drawn with the controls removed.
 */
export function stripControls(text: string): string {
  let clean = "";
  for (const char of text) if (!isControl(char.codePointAt(0) ?? 0)) clean += char;
  return clean;
}

/** `4s`, `12m`, `3h05m`, `2d`: short enough for a table cell. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** A bar of `width` cells, filled to `pct` and clamped to 0-100. */
export function bar(pct: number, width: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** `claude-opus-5-5` reads `opus`; an id that names no family is kept, cut to `width`. */
export function shortModel(model: string | null): string {
  if (model === null) return "—";
  const family = /(opus|sonnet|haiku|fable)/i.exec(model)?.[1];
  return family === undefined ? model : family.toLowerCase();
}

/** Controls are removed before measuring, so a column stays aligned once they are gone. */
export function fit(raw: string, width: number): string {
  const text = stripControls(raw);
  if (width <= 0) return "";
  if (text.length > width) return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}
