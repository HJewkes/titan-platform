import { createHash } from "node:crypto";

/**
 * I2's diff pin (v9.1 §2.3, Q13). `full` hashes the whole serialisation and is the identity; `core` hashes only each
 * file's path, mode lines and added and removed lines (or a binary's new blob id), and is read only by exclusion 2.
 * An ambiguous or missing merge base gives a pin that matches nothing, itself included.
 */
export type DiffPin = ExactDiffPin | AmbiguousDiffPin;

export interface ExactDiffPin {
  readonly kind: "exact";
  readonly head: string;
  /** The single `merge-base --all` of the head and `main`. */
  readonly base: string;
  /** The fresh `main` tip the base was taken from. */
  readonly main: string;
  readonly full: string;
  readonly core: string;
}

export interface AmbiguousDiffPin {
  readonly kind: "ambiguous";
  readonly head: string;
  readonly main: string;
  /** Every merge base git reported: none, or more than one. */
  readonly bases: readonly string[];
}

export interface DiffSerialisation {
  readonly full: string;
  readonly core: string;
}

interface FileLines {
  full: string[];
  core: string[];
}

// Main's own changes reach the header through the old blob id and through the function context a `.gitattributes`
// driver writes after `@@`; a constant marker keeps where one hunk ends without either.
const HUNK_MARKER = "@@";
const NEW_BLOB = /^index [0-9a-f]+\.\.([0-9a-f]+)/;

/** The §2.3 serialisation of `git diff` output made by the §2.3 command. */
export function serialiseDiff(raw: string): DiffSerialisation {
  const files = splitFiles(raw).map(serialiseFile);
  return { full: files.flatMap((file) => file.full).join("\n"), core: files.flatMap((file) => file.core).join("\n") };
}

export function diffHashes(raw: string): DiffSerialisation {
  const { full, core } = serialiseDiff(raw);
  return { full: sha256(full), core: sha256(core) };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function splitFiles(raw: string): string[][] {
  const files: string[][] = [];
  // Only the final newline is dropped: a blank context line printed as "" may sit right before it.
  for (const line of (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n")) {
    if (line.startsWith("diff --git ") || files.length === 0) files.push([]);
    files.at(-1)!.push(line);
  }
  return files.filter((file) => file.some((line) => line !== ""));
}

function serialiseFile(lines: string[]): FileLines {
  const binaryAt = lines.findIndex((line) => line === "GIT binary patch" || line.startsWith("Binary files "));
  if (binaryAt >= 0) return serialiseBinary(lines.slice(0, binaryAt));
  const hunkAt = lines.findIndex((line) => line.startsWith("@@"));
  const header = serialiseHeader(hunkAt < 0 ? lines : lines.slice(0, hunkAt));
  if (hunkAt < 0) return header;
  const body = serialiseHunks(lines.slice(hunkAt));
  return { full: [...header.full, ...body.full], core: [...header.core, ...body.core] };
}

/** Text drops its `index` line: the old blob id moves whenever main changes the file, inside the hunks or not. */
function serialiseHeader(lines: readonly string[]): FileLines {
  const kept = lines.filter((line) => line !== "" && !line.startsWith("index "));
  const core = kept.filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  return { full: kept, core };
}

/** The literal or delta data is dropped for the new blob id, which names the same bytes without depending on the old. */
function serialiseBinary(header: readonly string[]): FileLines {
  const blob = header.map((line) => NEW_BLOB.exec(line)?.[1]).find((id) => id !== undefined) ?? "missing";
  const text = serialiseHeader(header);
  return { full: [...text.full, `binary ${blob}`], core: [...text.core, `binary ${blob}`] };
}

function serialiseHunks(lines: readonly string[]): FileLines {
  const full: string[] = [];
  const core: string[] = [];
  let lastWasChange = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      full.push(HUNK_MARKER);
      lastWasChange = false;
      continue;
    }
    // `diff.suppressBlankEmpty` in a repository's own config prints a blank context line as "", which means " ".
    const kept = line === "" ? " " : line;
    full.push(kept);
    const change = kept.startsWith("+") || kept.startsWith("-");
    if (change || (kept.startsWith("\\") && lastWasChange)) core.push(kept);
    lastWasChange = change;
  }
  return { full, core };
}

/** Exclusion 2's proof: a conflict-free merge of main reproduces `current.head`'s tree from the reviewed head. */
export type MergeUpProof = { readonly ok: true; readonly mainParent: string } | { readonly ok: false; readonly reason: string };

/** Checks that `current.head` is a merge of main into `reviewedHead`, verified by `merge-tree --write-tree`. */
export type MergeUpCheck = (reviewedHead: string, current: ExactDiffPin) => Promise<MergeUpProof>;

export type DiffCarry =
  | { readonly carries: true; readonly by: "equal-full" }
  | { readonly carries: true; readonly by: "merge-up"; readonly mainParent: string }
  | { readonly carries: false; readonly reason: string };

/**
 * Whether a diff-pinned fact made at `reviewed` holds at `current`: only Q13's two exclusions carry it. Exclusion 2
 * runs the merge-up check only once core is equal, so a head move that changed the PR's own lines never pays for git.
 */
export async function diffCarry(reviewed: DiffPin, current: DiffPin, mergeUp: MergeUpCheck): Promise<DiffCarry> {
  if (reviewed.kind !== "exact") return { carries: false, reason: `the reviewed head ${reviewed.head} has an ambiguous merge base` };
  if (current.kind !== "exact") return { carries: false, reason: `head ${current.head} has an ambiguous merge base` };
  if (reviewed.full === current.full) return { carries: true, by: "equal-full" };
  if (reviewed.core !== current.core) return { carries: false, reason: `head ${current.head} changes the reviewed lines` };
  const proof = await mergeUp(reviewed.head, current);
  return proof.ok ? { carries: true, by: "merge-up", mainParent: proof.mainParent } : { carries: false, reason: proof.reason };
}
