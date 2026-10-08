const cache = new Map<string, RegExp>();

function toSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** `**` crosses directories (`**\/` also matches none), `*` and `?` stay within one path segment. */
export function matchesGlob(path: string, glob: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = new RegExp(`^${toSource(glob)}$`);
    cache.set(glob, re);
  }
  return re.test(path);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}
