// Vendored from titan-design packages/review-schema/src/locks.ts @ 4fcb3827a72cacf1f81a356bad32630e1f39f9e6 (tag
// review-schema-v0.3.0), byte-for-byte below this header, because 0.3.0 is not on npm (TD-805). TP-3232 deletes this
// directory when it installs the release. Never edit: re-vendor from a tag.
import { z } from 'zod'
import { duplicates, type Problem } from './contract.ts'

export const LOCKS_SCHEMA_ID = 'titan-locks/1'

/** What a lock's decision is about; a token's category gives its axis. */
export const LOCK_AXES = ['colour', 'typography', 'spacing', 'api', 'motion'] as const

/** `open` until its holder merges (`merged`) or the decision is withdrawn (`released`). */
export const LOCK_STATUSES = ['open', 'merged', 'released'] as const

/** A dependent PR is rebased on the holder's head (`stack-on`) or waits for the lock (`defer`). */
export const DEPENDENT_MODES = ['stack-on', 'defer'] as const

const lockId = z.string().regex(/^L-[0-9]{4}$/, 'a lock id is L- then four digits')
const sha40 = z.string().regex(/^[0-9a-f]{40}$/, 'must be 40 lower-case hex characters')
const prNumber = z.number().int().positive()
const text = z.string().min(1)
const oneOrMany = z.union([text, z.array(text).min(1)])

/** The key of a lock: the decision row it implements, not a PR head. */
export const LockDecisionSchema = z
  .object({
    /** The decisions-ledger row id, or the rows one lock implements together. */
    ledger: oneOrMany,
    decisionsItem: text,
    round: text,
    questionId: oneOrMany,
  })
  .strict()

/** A PR at a head that implements the decision; a lock has zero or more. */
export const LockHolderSchema = z
  .object({ pr: prNumber, headSha: sha40, branch: text.optional(), task: text.optional() })
  .strict()

/** A colour property in one theme mode; `from` and `to` are the values it moves between. */
export const LockTokenSchema = z
  .object({
    name: text,
    mode: z.enum(['light', 'dark']),
    from: text.optional(),
    to: text.optional(),
  })
  .strict()

/** What a decision changes, declared by hand when no holder head exists to derive it from. */
export const LockTouchesSchema = z
  .object({
    tokens: z.array(LockTokenSchema),
    components: z.array(text),
    axis: z.enum(LOCK_AXES),
  })
  .strict()

/** What a holder head changes, derived from `merge-base(main, head)..head`. */
export const LockFootprintSchema = z
  .object({
    derivedFrom: z.object({ mainSha: sha40, headSha: sha40 }).strict().nullable(),
    tokens: z.array(LockTokenSchema),
    files: z.array(text),
    components: z
      .object({
        direct: z.array(text),
        readers: z.array(text),
        rendersCount: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict()

const isoDateTime = z.iso.datetime()

export const LockSchema = z
  .object({
    id: lockId,
    status: z.enum(LOCK_STATUSES),
    title: text.optional(),
    decision: LockDecisionSchema,
    holders: z.array(LockHolderSchema),
    touches: LockTouchesSchema.optional(),
    footprint: LockFootprintSchema.optional(),
    axes: z.array(z.enum(LOCK_AXES)).optional(),
    /** Locks that must merge before this one. */
    after: z.array(lockId),
    precedent: z
      .object({ adr: text.nullable(), contractEntry: text.nullable() })
      .partial()
      .strict()
      .optional(),
    openedBy: text.optional(),
    openedAt: isoDateTime.optional(),
    closedAt: isoDateTime.nullable().optional(),
    mergeSha: sha40.nullable().optional(),
  })
  .strict()

/** A PR that overlaps an open lock, and how it waits for it. */
export const LockDependentSchema = z
  .object({ pr: prNumber, lock: lockId, mode: z.enum(DEPENDENT_MODES), reason: text })
  .strict()

const LocksObject = z
  .object({
    schema: z.literal(LOCKS_SCHEMA_ID),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')
      .optional(),
    updatedAt: isoDateTime.optional(),
    locks: z.array(LockSchema),
    dependents: z.array(LockDependentSchema).default([]),
  })
  .strict()

type LocksShape = z.output<typeof LocksObject>

function ledgerRows(decision: z.output<typeof LockDecisionSchema>): string[] {
  return typeof decision.ledger === 'string' ? [decision.ledger] : decision.ledger
}

function keyProblems(locks: LocksShape['locks']): Problem[] {
  const ids = duplicates(locks.map((l) => l.id)).map((id) => `lock id ${id} is used twice`)
  const owner = new Map<string, string>()
  const rows = locks.flatMap((l) =>
    ledgerRows(l.decision).flatMap((row) => {
      const first = owner.get(row)
      if (first === undefined) owner.set(row, l.id)
      return first === undefined || first === l.id
        ? []
        : [`decision row ${row} is keyed by both ${first} and ${l.id}`]
    })
  )
  return [...ids, ...rows].map((message) => ({ path: 'locks', message }))
}

function unknownIdProblems(m: LocksShape): Problem[] {
  const known = new Set(m.locks.map((l) => l.id))
  const after = m.locks.flatMap((l) =>
    l.after.filter((a) => !known.has(a)).map((a) => `lock ${l.id}: after names unknown lock ${a}`)
  )
  const dependents = m.dependents
    .filter((d) => !known.has(d.lock))
    .map((d) => `dependent PR #${d.pr} names unknown lock ${d.lock}`)
  return [
    ...after.map((message) => ({ path: 'locks', message })),
    ...dependents.map((message) => ({ path: 'dependents', message })),
  ]
}

/** Each `after` cycle once, as its ids in edge order starting from the smallest id. */
export function afterCycles(locks: { id: string; after: string[] }[]): string[][] {
  const edges = new Map(locks.map((l) => [l.id, l.after]))
  const cycles = new Map<string, string[]>()
  const visit = (id: string, path: string[]): void => {
    const seen = path.indexOf(id)
    if (seen >= 0) {
      const cycle = path.slice(seen)
      const start = cycle.indexOf([...cycle].sort()[0]!)
      const canonical = [...cycle.slice(start), ...cycle.slice(0, start)]
      cycles.set(canonical.join(' '), canonical)
      return
    }
    for (const next of edges.get(id) ?? []) if (edges.has(next)) visit(next, [...path, id])
  }
  for (const id of edges.keys()) visit(id, [])
  return [...cycles.values()]
}

function cycleProblems(locks: LocksShape['locks']): Problem[] {
  return afterCycles(locks).map((cycle) => ({
    path: 'locks',
    message: `after cycle: ${[...cycle, cycle[0]].join(' -> ')}`,
  }))
}

function holderlessProblems(locks: LocksShape['locks']): Problem[] {
  return locks
    .filter((l) => l.holders.length === 0 && l.touches === undefined)
    .map((l) => ({ path: 'locks', message: `lock ${l.id} has no holder, so it declares touches` }))
}

/** The checks across locks that a single field cannot make. */
export function locksProblems(m: LocksShape): Problem[] {
  return [
    ...keyProblems(m.locks),
    ...unknownIdProblems(m),
    ...cycleProblems(m.locks),
    ...holderlessProblems(m.locks),
  ]
}

/**
 * The lock registry: each lock is keyed on the decision it implements, held by zero or more PRs
 * at heads, ordered by `after`, and waited on by `dependents`.
 */
export const LocksSchema = LocksObject.superRefine((m, ctx) => {
  for (const { path, message } of locksProblems(m))
    ctx.addIssue({ code: 'custom', path: [path], message })
})

export type LocksInput = z.input<typeof LocksSchema>
export type Locks = z.output<typeof LocksSchema>
export type Lock = z.output<typeof LockSchema>
export type LockDependent = z.output<typeof LockDependentSchema>

/** Parses a registry, throwing a ZodError whose messages name each offending lock id. */
export function parseLocks(input: unknown): Locks {
  return LocksSchema.parse(input)
}
