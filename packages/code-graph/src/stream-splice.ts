import type { FileDigest } from "./file-digest.js";
import type { StreamedFiles } from "./incremental.js";
import type { GraphFragment } from "./types.js";

/**
 * `first` with the files `second` re-extracted put in place of what `first` gave
 * them, at the same walk positions, so the merge sees the order one stream gives.
 */
export function spliceStream(first: StreamedFiles, second: StreamedFiles, walkOrder: readonly string[]): StreamedFiles {
  const replacement = new Map<string, GraphFragment[]>();
  second.fragments.forEach((f, i) => {
    const id = second.fragmentFileIds[i] ?? "";
    replacement.set(id, [...(replacement.get(id) ?? []), f]);
  });
  const out: StreamedFiles = {
    fragments: [],
    fragmentFileIds: [],
    cosmeticFileIds: new Set([...first.cosmeticFileIds, ...second.cosmeticFileIds]),
    structuralByFileId: new Map([...first.structuralByFileId, ...second.structuralByFileId]),
    digests: [],
  };
  first.fragments.forEach((f, i) => {
    const id = first.fragmentFileIds[i] ?? "";
    const swapped = replacement.get(id);
    const fragments = swapped ?? [f];
    if (swapped) replacement.delete(id);
    out.fragments.push(...fragments);
    out.fragmentFileIds.push(...fragments.map(() => id));
  });
  const position = new Map(walkOrder.map((id, i) => [id, i]));
  const at = (d: FileDigest): number => position.get(d.fileId) ?? 0;
  out.digests = [...first.digests, ...second.digests].sort((a, b) => at(a) - at(b));
  return out;
}
