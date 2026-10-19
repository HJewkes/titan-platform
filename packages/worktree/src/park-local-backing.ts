import { gitOrNull } from "./git.js";

/** A copied snapshot of the actual local branch and commit being parked. */
export interface ParkLocalBackingObservation {
  readonly branch: string;
  readonly head: string;
  readonly worktree: string;
}

/** Caller-supplied local commit and opaque correlation; not authenticated provider evidence. */
export interface ParkLocalBackingCandidate {
  readonly oid: string;
  readonly ref: string;
}

/** Called lazily only when ordinary origin backing did not prove the captured HEAD. */
export type ParkLocalBackingReader = (
  observation: Readonly<ParkLocalBackingObservation>
) => Promise<readonly ParkLocalBackingCandidate[]>;

function copyCandidates(
  value: unknown
): readonly ParkLocalBackingCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const copied: ParkLocalBackingCandidate[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return undefined;
    const entry: unknown = Reflect.get(value, String(i));
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return undefined;
    const oid: unknown = Reflect.get(entry, "oid");
    const ref: unknown = Reflect.get(entry, "ref");
    if (
      typeof oid !== "string" ||
      (oid.length !== 40 && oid.length !== 64) ||
      /[^0-9a-f]/iu.test(oid) ||
      typeof ref !== "string"
    )
      return undefined;
    copied.push(Object.freeze({ oid, ref }));
  }
  return Object.freeze(copied);
}

/** Snapshot all input before asynchronous probes; malformed results and callback failures give no proof. */
export async function localBackingCandidates(
  reader: (
    observation: Readonly<ParkLocalBackingObservation>
  ) => Promise<unknown>,
  observation: ParkLocalBackingObservation
): Promise<readonly ParkLocalBackingCandidate[] | undefined> {
  try {
    return copyCandidates(await reader(Object.freeze({ ...observation })));
  } catch {
    return undefined;
  }
}

/** An exact local COMMIT object, not an annotated tag or missing object, must contain the captured HEAD. */
export async function localBackingRef(
  candidates: readonly ParkLocalBackingCandidate[],
  observation: ParkLocalBackingObservation
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const commit = await gitOrNull(
      ["rev-parse", "--verify", candidate.oid + "^{commit}"],
      observation.worktree
    );
    if (commit?.toLowerCase() !== candidate.oid.toLowerCase()) continue;
    if (
      (await gitOrNull(
        ["merge-base", "--is-ancestor", observation.head, candidate.oid],
        observation.worktree
      )) !== null
    )
      return candidate.ref;
  }
  return undefined;
}
