import type { FakeGitHub } from "./fake-types.js";
import type { RepoEntry } from "./port-types.js";

/** The `files` keyed `ref:path/<name>` with no further slash, sorted by path as GitHub sorts them; none is null, as git keeps no empty directory. */
export function fakeListDirectory(fake: FakeGitHub, path: string, ref: string): RepoEntry[] | null {
  const prefix = `${ref}:${path}/`;
  const entries = [...fake.files.entries()]
    .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map(([key, file]) => ({ path: key.slice(ref.length + 1), blobSha: file.blobSha }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return entries.length === 0 ? null : entries;
}
