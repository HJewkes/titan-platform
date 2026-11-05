import type { z } from "zod";
import type { ArPorts, SnapshotCutSchema, SnapshotRequest, SyncRequest, SyncResultSchema } from "../ports.js";

export interface SnapshotCalls {
  snapshot: SnapshotRequest[];
  sync: SyncRequest[];
}

export interface SnapshotOptions {
  /** By default a cut at the requested sha with synthetic refs and PR number; a test throws or holds with it. */
  snapshot?: (input: SnapshotRequest, call: number) => Promise<z.input<typeof SnapshotCutSchema>>;
  /** By default the snapshot PR is still open. */
  sync?: (input: SyncRequest, call: number) => Promise<z.input<typeof SyncResultSchema>>;
}

/** The snapshot names the plan gives: a tag per cut and a `-snap` branch beside the ratchet namespace, never inside it. */
function fakeCut({ runId, k, sha, ratchetPrefix }: SnapshotRequest): Promise<z.input<typeof SnapshotCutSchema>> {
  const tag = `refs/tags/ar/fixture/${runId}/m${k}`;
  return Promise.resolve({ k, tag, sha, branch: `refs/heads/${ratchetPrefix}-snap/${runId}/m${k}`, pr: 100 + k, logSha: sha });
}

/** Records every cut and sync; neither touches the fixture repo unless a test's own function does. */
export function fakeSnapshotPorts(calls: SnapshotCalls, options: SnapshotOptions): Pick<ArPorts, "snapshot" | "sync"> {
  return {
    async snapshot(input) {
      calls.snapshot.push(input);
      return (options.snapshot ?? fakeCut)(input, calls.snapshot.length);
    },
    async sync(input) {
      calls.sync.push(input);
      return options.sync ? options.sync(input, calls.sync.length) : { state: "open" };
    },
  };
}
