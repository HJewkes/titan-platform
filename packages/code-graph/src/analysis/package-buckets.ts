export interface PackageRoot {
  /** Path relative to repo root, posix-separated (e.g., "packages/cli"). Empty for repo-root package. */
  id: string;
  /** Display name from package.json or directory basename. */
  name: string;
}

/**
 * For each file id, find the longest matching package prefix.
 * Returns a Map from package id → file ids assigned to it.
 * Files matching no package are returned under the empty-string key.
 */
export function bucketFilesByPackage(
  fileIds: readonly string[],
  packages: readonly PackageRoot[],
): Map<string, string[]> {
  const sorted = [...packages].sort((a, b) => b.id.length - a.id.length);
  const out = new Map<string, string[]>();
  for (const id of fileIds) {
    const pkg = matchPackage(id, sorted);
    const key = pkg?.id ?? "";
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
    }
    list.push(id);
  }
  return out;
}

function matchPackage(
  fileId: string,
  packagesByLongestId: readonly PackageRoot[],
): PackageRoot | null {
  for (const p of packagesByLongestId) {
    if (p.id === "") continue;
    if (fileId === p.id) return p;
    if (fileId.startsWith(`${p.id}/`)) return p;
  }
  return null;
}
