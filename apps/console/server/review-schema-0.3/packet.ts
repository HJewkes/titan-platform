// Vendored from titan-design packages/review-schema/src/packet.ts @ 4fcb3827a72cacf1f81a356bad32630e1f39f9e6 (tag
// review-schema-v0.3.0), byte-for-byte below this header, because 0.3.0 is not on npm (TD-805). TP-3232 deletes this
// directory when it installs the release. Never edit: re-vendor from a tag.
import { z } from 'zod'
import { duplicates } from './contract.ts'

// A decision packet on a pick-one or pick-many: each option's pros and cons, the measured tables
// that decide between them, and an option × scenario viewer over the question's frames.

const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, _ and - only')
const text = (what: string) => z.string({ error: what }).regex(/\S/, what)

/** What one option is, beyond its label: its pros and cons. Every field is markdown. Always shown; never gated by the recommendation. */
export const OptionDetailSchema = z
  .object({
    /** What picking it means, with the numbers that decide it. */
    detail: text('an option detail says what picking it means'),
    /** Where this option is weakest, even when it wins. */
    weakPoint: text('a weak point is not blank').optional(),
    /** What happens after the owner picks it: the follow-up an agent will carry out. */
    after: text('an after text is not blank').optional(),
  })
  .strict()

/** How a table cell reads: the page shows each tone as a class and a text marker, never colour alone. */
export const CELL_TONES = ['pass', 'fail', 'neutral'] as const

const CellSchema = z.union([
  z.string(),
  z
    .object({
      text: z.string(),
      tone: z.enum(CELL_TONES),
      /** The columns this cell covers; a row counts it that many times. */
      span: z.number().int().min(2).optional(),
    })
    .strict(),
])

/**
 * A measured table. The first column heads the row labels; each row has one cell per later column.
 * A column may stand for an option, so the page can mark the recommended and picked columns.
 */
export const EvidenceTableSchema = z
  .object({
    caption: z.string().min(1),
    columns: z
      .array(z.object({ label: z.string().min(1), option: z.string().optional() }).strict())
      .min(2),
    rows: z
      .array(z.object({ label: z.string().min(1), cells: z.array(CellSchema).min(1) }).strict())
      .min(1),
    /** Markdown under the table: how to read it. */
    note: z.string().optional(),
  })
  .strict()

const view = z.object({ id, label: z.string().min(1) }).strict()

/** The option × scenario viewer. cells[option][viewId] = a variant key of the question's frames. */
export const CompareSchema = z
  .object({
    views: z.array(view).min(1),
    cells: z.record(z.string(), z.record(z.string(), id)),
    /** Options shown when the page opens. Default: every option when there are at most 3, else the first two. */
    shown: z.array(z.string()).min(1).optional(),
  })
  .strict()

export type OptionDetail = z.output<typeof OptionDetailSchema>
export type CellTone = (typeof CELL_TONES)[number]
export type EvidenceCell = z.output<typeof CellSchema>
export type EvidenceTable = z.output<typeof EvidenceTableSchema>
export type Compare = z.output<typeof CompareSchema>

interface PacketQuestion {
  id: string
  options?: string[]
  frames?: string[]
  optionDetails?: Record<string, OptionDetail>
  evidence?: EvidenceTable[]
  compare?: Compare
  recommendation?: { answer: string | string[] | number; fallback?: string }
}

interface PacketRound {
  variants: { key: string; storyId?: string; image?: string; clip?: string }[]
  questions: PacketQuestion[]
}

const notAnOption = (q: PacketQuestion, what: string, option: string) =>
  q.options?.includes(option) ? [] : [`${what} "${option}" is not one of its options`]

function evidenceProblems(q: PacketQuestion): string[] {
  return (q.evidence ?? []).flatMap((table) => {
    const where = `evidence "${table.caption}"`
    const [labels, ...data] = table.columns
    const width = (cells: EvidenceCell[]) =>
      cells.reduce((sum, c) => sum + (typeof c === 'string' ? 1 : (c.span ?? 1)), 0)
    return [
      ...(labels?.option === undefined
        ? []
        : [`${where}: its first column heads the row labels and stands for no option`]),
      ...data.flatMap((c) =>
        c.option === undefined ? [] : notAnOption(q, `${where} column`, c.option)
      ),
      ...table.rows
        .filter((row) => width(row.cells) !== data.length)
        .map(
          (row) =>
            `${where} row "${row.label}" has ${width(row.cells)} cells for ${data.length} columns`
        ),
    ]
  })
}

const sourceOf = (v: PacketRound['variants'][number]) =>
  v.image !== undefined ? 'image' : v.clip !== undefined ? 'clip' : 'live story'

function compareCellProblems(q: PacketQuestion, compare: Compare, m: PacketRound): string[] {
  const viewIds = compare.views.map((v) => v.id)
  const rows = Object.entries(compare.cells)
  const keys = rows.flatMap(([, row]) => Object.values(row))
  const frames = new Set(q.frames)
  const sources = new Set(m.variants.filter((v) => keys.includes(v.key)).map((v) => sourceOf(v)))
  return [
    ...[...new Set(duplicates(viewIds))].map((v) => `compare view ${v} repeats`),
    ...rows.flatMap(([option, row]) => [
      ...notAnOption(q, 'compare row', option),
      ...Object.keys(row)
        .filter((v) => !viewIds.includes(v))
        .map((v) => `compare row "${option}" names unknown view ${v}`),
      ...viewIds
        .filter((v) => row[v] === undefined)
        .map((v) => `compare row "${option}" has no frame for view ${v}`),
    ]),
    ...keys.filter((k) => !frames.has(k)).map((k) => `compare cell ${k} is not one of its frames`),
    ...[...new Set(duplicates(keys))].map((k) => `compare cell ${k} is in two cells`),
    ...(sources.size > 1
      ? [`compare frames mix sources (${[...sources].join(', ')}); compared frames share one`]
      : []),
  ]
}

function compareProblems(q: PacketQuestion, m: PacketRound): string[] {
  const { compare } = q
  if (!compare) return []
  return [
    ...compareCellProblems(q, compare, m),
    ...(compare.shown ?? [])
      .filter((option) => compare.cells[option] === undefined)
      .map((option) => `compare shown "${option}" has no compare row`),
  ]
}

function fallbackProblems(q: PacketQuestion): string[] {
  const { fallback, answer } = q.recommendation ?? {}
  if (fallback === undefined) return []
  const answered = [answer].flat()
  return [
    ...notAnOption(q, 'recommendation fallback', fallback),
    ...(answered.includes(fallback)
      ? [`recommendation fallback "${fallback}" is the recommended answer`]
      : []),
  ]
}

/** What a question's packet names that is not its own: options, frames, views and table widths. */
export function packetProblems(m: PacketRound): string[] {
  return m.questions.flatMap((q) =>
    [
      ...Object.keys(q.optionDetails ?? {}).flatMap((o) => notAnOption(q, 'optionDetails', o)),
      ...evidenceProblems(q),
      ...compareProblems(q, m),
      ...fallbackProblems(q),
    ].map((problem) => `question ${q.id}: ${problem}`)
  )
}
