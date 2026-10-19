import type { FileDigest } from "./file-digest.js";
import type { StreamedFiles } from "./incremental.js";
import type { GraphFragment } from "./types.js";

/**
 * `first` with the files `second` re-extracted put in place of everything
 * `first` gave them (fragments, digests, a cosmetic mark), at the same walk
 * positions, so the merge sees the order one stream gives.
 */
export function spliceStream(first: StreamedFiles, second: StreamedFiles, walkOrder: readonly string[]): StreamedFiles {
  const replacement = new Map<string, GraphFragment[]>();
  second.fragments.forEach((f, i) => {
    const id = second.fragmentFileIds[i] ?? "";
    replacement.set(id, [...(replacement.get(id) ?? []), f]);
  });
  const replaced = new Set(replacement.keys());
  const out: StreamedFiles = {
    fragments: [],
    fragmentFileIds: [],
    cosmeticFileIds: new Set([...first.cosmeticFileIds].filter((id) => !replaced.has(id))),
    structuralByFileId: new Map([...first.structuralByFileId, ...second.structuralByFileId]),
    digests: [],
  };
  for (const id of second.cosmeticFileIds) out.cosmeticFileIds.add(id);
  first.fragments.forEach((f, i) => {
    const id = first.fragmentFileIds[i] ?? "";
    const fragments = replaced.has(id) ? (replacement.get(id) ?? []) : [f];
    replacement.delete(id);
    out.fragments.push(...fragments);
    out.fragmentFileIds.push(...fragments.map(() => id));
  });
  const position = new Map(walkOrder.map((id, i) => [id, i]));
  const at = (d: FileDigest): number => position.get(d.fileId) ?? 0;
  const kept = first.digests.filter((d) => !replaced.has(d.fileId));
  out.digests = [...kept, ...second.digests].sort((a, b) => at(a) - at(b));
  return out;
}
