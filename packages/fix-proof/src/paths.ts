const UNSAFE = /[\\\0]/;

/** A repo-relative POSIX path with `.` and empty segments removed, or null when it is absolute or escapes with `..`. */
export function normalizeRelative(path: string): string | null {
  if (path === "" || path.startsWith("/") || UNSAFE.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function absoluteSegments(path: string): string[] | null {
  if (!path.startsWith("/") || UNSAFE.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** The path of an absolute file below an absolute root, or null when either is not absolute or the file is outside the root. */
export function relativeToRoot(file: string, root: string): string | null {
  const fileSegments = absoluteSegments(file);
  const rootSegments = absoluteSegments(root);
  if (!fileSegments || !rootSegments || fileSegments.length <= rootSegments.length) return null;
  if (rootSegments.some((segment, index) => fileSegments[index] !== segment)) return null;
  return fileSegments.slice(rootSegments.length).join("/");
}
