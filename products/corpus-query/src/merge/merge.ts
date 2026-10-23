import type { ConfirmRow } from "../judge/verdict.js";
import { compareStoryOrder } from "../story-order.js";
import type { StoryOrderKey } from "../types.js";

/** A verified confirm row plus where it was read: the ref and order come from the chapter, not the judge. */
export interface SourcedRow extends ConfirmRow {
  ref: string;
  book: string;
  order: StoryOrderKey;
}

export interface MergedRow {
  entity: string;
  subject: string;
  period: string;
  periodInferred: boolean;
  detail: string;
  role: string;
  ref: string;
  quote: string;
  order: StoryOrderKey;
}

export interface NearDuplicate {
  a: MergedRow;
  b: MergedRow;
}

export interface MergeResult {
  main: MergedRow[];
  needsRuling: MergedRow[];
  referencedEarlier: MergedRow[];
  nearDuplicates: NearDuplicate[];
  /** Rows about losses, previews and other non-wins; counted so the coverage section can say so. */
  dropped: number;
}

export interface MergeOptions {
  /** Judge-reported alias to canonical name; both sides are matched after normalisation. */
  aliases?: Record<string, string>;
}

export function normalise(text: string): string {
  return text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function aliasResolver(aliases: Record<string, string>): (name: string) => string {
  const table = new Map(Object.entries(aliases).map(([from, to]) => [normalise(from), normalise(to)]));
  return (name) => table.get(normalise(name)) ?? normalise(name);
}

function modalPeriodByBook(rows: SourcedRow[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.period) continue;
    const book = counts.get(r.book) ?? new Map<string, number>();
    book.set(r.period, (book.get(r.period) ?? 0) + 1);
    counts.set(r.book, book);
  }
  const modal = new Map<string, string>();
  for (const [book, periods] of counts) {
    modal.set(book, [...periods].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0]);
  }
  return modal;
}

function toMerged(r: SourcedRow, period: string, inferred: boolean): MergedRow {
  const { entity, subject, detail, role, ref, quote, order } = r;
  return { entity, subject, period, periodInferred: inferred, detail, role, ref, quote, order };
}

function nearDuplicatesOf(rows: MergedRow[]): NearDuplicate[] {
  const found: NearDuplicate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [a, b] = [rows[i]!, rows[j]!];
      if (normalise(a.period) !== normalise(b.period)) continue;
      const close = editDistance(normalise(a.entity), normalise(b.entity)) <= 2;
      if (close || a.ref === b.ref) found.push({ a, b });
    }
  }
  return found;
}

function groupRows(rows: SourcedRow[], modal: Map<string, string>, canon: (n: string) => string): SourcedRow[][] {
  const byKey = new Map<string, SourcedRow[]>();
  for (const r of rows) {
    const key = [canon(r.entity), canon(r.subject), normalise(r.period || modal.get(r.book) || "")].join("|");
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  return [...byKey.values()];
}

/** A win we are sure of is a main row; an unsure win needs a ruling; a recap alone is only "referenced earlier". */
function classify(group: SourcedRow[]): { bucket: "main" | "needsRuling" | "referencedEarlier"; chosen: SourcedRow } {
  const wins = group.filter((r) => r.event === "won");
  const sure = wins.filter((r) => r.confidence === "sure");
  const bucket = sure.length > 0 ? "main" : wins.length > 0 ? "needsRuling" : "referencedEarlier";
  const pool = sure.length > 0 ? sure : wins.length > 0 ? wins : group;
  return { bucket, chosen: [...pool].sort((a, b) => compareStoryOrder(a.order, b.order))[0]! };
}

export function mergeRows(rows: SourcedRow[], options: MergeOptions = {}): MergeResult {
  const canon = aliasResolver(options.aliases ?? {});
  const eligible = rows.filter((r) => r.event === "won" || r.event === "referenced");
  const modal = modalPeriodByBook(eligible);
  const buckets = { main: [] as MergedRow[], needsRuling: [] as MergedRow[], referencedEarlier: [] as MergedRow[] };
  for (const group of groupRows(eligible, modal, canon)) {
    const { bucket, chosen } = classify(group);
    const inferred = !chosen.period && modal.has(chosen.book);
    buckets[bucket].push(toMerged(chosen, chosen.period || modal.get(chosen.book) || "", inferred));
  }
  const byOrder = (a: MergedRow, b: MergedRow) => compareStoryOrder(a.order, b.order);
  for (const list of Object.values(buckets)) list.sort(byOrder);
  return { ...buckets, nearDuplicates: nearDuplicatesOf(buckets.main), dropped: rows.length - eligible.length };
}
