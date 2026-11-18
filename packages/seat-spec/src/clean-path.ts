const DEL = 0x7f;

const hasControlChar = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === DEL);

/**
 * The one path rule for every path a seat or a launcher supplies: absolute, already clean, and
 * judged as written. An empty, `.` or `..` segment or a trailing slash is refused rather than
 * normalized, because the kernel follows a symlink before it applies `..`, so a tidied string can
 * name a different file than the one the reader opened. `/` itself is clean.
 */
export function isCleanAbsolutePath(value: string): boolean {
  if (value === "/") return true;
  if (!value.startsWith("/") || hasControlChar(value)) return false;
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
