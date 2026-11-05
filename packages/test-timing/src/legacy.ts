import { z } from "zod";
import { TIMING_SCHEMA_ID, type TimingArtifact, type TimingFile } from "./artifact.js";

/** What `gh run view --json databaseId,attempt,headSha,headBranch,event,createdAt` says about a CI run. */
export interface GhRunMeta {
  databaseId: number;
  attempt: number;
  headSha: string;
  headBranch: string | null;
  event: string;
  createdAt: string;
  /** owner/repo, which `gh run view` does not return. */
  repo: string;
}

const legacyFile = z.looseObject({
  project: z.string(),
  file: z.string().min(1),
  state: z.string().min(1),
  environmentMs: z.number().nonnegative(),
  prepareMs: z.number().nonnegative(),
  collectMs: z.number().nonnegative(),
  setupMs: z.number().nonnegative(),
  testMs: z.number().nonnegative(),
});

const legacySchema = z.looseObject({ files: z.array(legacyFile) });

/** A record from before the run header (TP-4436 S0): `{ files }` alone, with no totals or test counts. */
export function isLegacyArtifact(input: unknown): boolean {
  return typeof input === "object" && input !== null && !("schema" in input) && "files" in input;
}

// ubuntu-latest is a 4-vCPU hosted runner; the pre-header reporter recorded no core count of its own.
const HOSTED_CPUS = 4;

function upgradeFile(file: z.infer<typeof legacyFile>): TimingFile {
  const { project, file: path, state, environmentMs, prepareMs, collectMs, setupMs, testMs } = file;
  // The old reporter never counted tests; 0 marks "unknown", so ms/test is undefined rather than wrong.
  return { project, file: path, state, environmentMs, prepareMs, collectMs, setupMs, testMs, totalMs: collectMs + setupMs + testMs, tests: 0 };
}

export interface LegacyUpgrade {
  shard: string | null;
  /** The old record never said; the caller knows (a main push runs the full suite, a pull request may not). */
  scope: "full" | "scoped";
}

/**
 * Builds the v1 header a pre-header CI artifact lacks from the run's own metadata, so the hosted runs measured
 * before S1 join the corpus. Fields the old reporter never saw (node, load, wall time) stay empty or zero.
 */
export function upgradeLegacyArtifact(input: unknown, meta: GhRunMeta, { shard, scope }: LegacyUpgrade): TimingArtifact {
  const { files } = legacySchema.parse(input);
  const index = shard?.split("/")[0] ?? "1";
  const run = {
    id: `gha:${meta.databaseId}:${meta.attempt}:${index}`,
    runner: "gha",
    host: "github-hosted",
    repo: meta.repo,
    commit: meta.headSha,
    mergeSha: null,
    baseSha: null,
    branch: meta.headBranch,
    pr: null,
    event: meta.event,
    scope: { mode: scope, filters: [] },
    shard,
    cpus: HOSTED_CPUS,
    maxWorkers: null,
    node: "unknown",
    vitest: null,
    startedAt: new Date(meta.createdAt).toISOString(),
    load: null,
    wallMs: 0,
    exit: null,
  };
  return { schema: TIMING_SCHEMA_ID, run, files: files.map(upgradeFile) };
}
