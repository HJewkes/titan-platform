import { z } from "zod";

export const TIMING_SCHEMA_ID = "titan.test-timing/v1";

type Mode = "write" | "read";
type ObjectFactory = <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T>;

const ms = z.number().nonnegative();
const nullableText = z.string().min(1).nullable();

function runShape(obj: ObjectFactory) {
  const scope = obj({ mode: z.enum(["full", "scoped", "related"]), filters: z.array(z.string()) });
  const load = obj({ start: z.number().nonnegative(), mean: z.number().nonnegative(), max: z.number().nonnegative() });
  return obj({
    id: z.string().min(1),
    runner: z.string().min(1),
    host: z.string().min(1),
    repo: nullableText,
    commit: nullableText,
    mergeSha: nullableText,
    baseSha: nullableText,
    branch: nullableText,
    pr: z.number().int().positive().nullable(),
    event: z.string().min(1),
    scope,
    shard: z.string().regex(/^\d+\/\d+$/).nullable(),
    cpus: z.number().int().positive(),
    maxWorkers: z.number().int().positive().nullable(),
    node: z.string().min(1),
    vitest: nullableText,
    startedAt: z.iso.datetime(),
    load: load.nullable(),
    wallMs: ms,
    exit: z.enum(["passed", "failed", "interrupted"]).nullable(),
  });
}

function fileShape(obj: ObjectFactory) {
  return obj({
    project: z.string(),
    file: z.string().min(1),
    state: z.string().min(1),
    environmentMs: ms,
    prepareMs: ms,
    collectMs: ms,
    setupMs: ms,
    testMs: ms,
    totalMs: ms,
    tests: z.number().int().nonnegative(),
  });
}

// Every object is built twice from one shape: strict for the reporter, loose so a reader keeps keys a newer writer added.
function build(obj: ObjectFactory) {
  return obj({ schema: z.literal(TIMING_SCHEMA_ID), run: runShape(obj), files: z.array(fileShape(obj)) });
}

const schemaFor = (mode: Mode) => build((mode === "write" ? z.strictObject : z.looseObject) as ObjectFactory);

/** Strict: what a reporter must write. An unknown key is an error, so a typo never reaches the corpus. */
export const timingArtifactSchema = schemaFor("write");
/** Loose: what an ingester accepts, keeping keys a newer reporter added. */
export const timingArtifactReadSchema = schemaFor("read");

export type TimingArtifact = z.infer<typeof timingArtifactSchema>;
export type TimingRun = TimingArtifact["run"];
export type TimingFile = TimingArtifact["files"][number];

/** Reads one `vitest-file-timing.json`; throws a ZodError naming the first bad field. */
export function parseTimingArtifact(input: unknown): TimingArtifact {
  return timingArtifactReadSchema.parse(input);
}
