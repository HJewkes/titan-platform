import { EdgeTable, EntityTable, quoteIdent, refKind, type Db, type EntityRow } from "@titan-design/store-sqlite";
import { randomUUID } from "node:crypto";
import { BLOCKED_KIND, BULLET_KIND, DEFAULT_MEMORY_TABLES, SUPERSEDES, type MemoryTables } from "./schema.js";
import { DEFAULT_HALF_LIFE_DAYS } from "./scoring.js";
import type { Bullet, FeedbackEvent, FeedbackType, NewBullet } from "./types.js";

export const bulletRef = refKind("memory");
const blockedRef = refKind("memory-blocked");

export interface PlaybookStoreOptions {
  tables?: MemoryTables;
  now?: () => Date;
}

export interface FeedbackInput {
  sessionRef?: string | null;
  reason?: string | null;
  at?: string;
}

export interface BlockedPattern {
  pattern: string;
  reason: string;
  blockedAt: string;
}

interface RawFeedbackRow {
  id: number;
  bullet_ref: string;
  type: FeedbackType;
  at: string;
  session_ref: string | null;
  reason: string | null;
}

type Attrs = Omit<Bullet, "id" | "content" | "category">;

export class BulletNotFound extends Error {
  constructor(id: string) {
    super(`bullet not found: ${id}`);
    this.name = "BulletNotFound";
  }
}

/**
 * Bullets are interval entities (`kind = bullet`, name = category, attrs = the
 * rest), so retirement is an attrs change plus a `supersedes` edge, never a
 * delete. Feedback is an append-only log; nothing here ever updates or removes
 * an event.
 */
export class PlaybookStore {
  readonly tables: MemoryTables;
  private readonly entities: EntityTable;
  private readonly edges: EdgeTable;
  private readonly now: () => Date;
  private readonly insertFeedback;
  private readonly feedbackByBullet;
  private readonly allFeedback;

  constructor(db: Db, options: PlaybookStoreOptions = {}) {
    this.tables = options.tables ?? DEFAULT_MEMORY_TABLES;
    this.now = options.now ?? (() => new Date());
    this.entities = new EntityTable(db, { name: this.tables.entity });
    this.edges = new EdgeTable(db, { name: this.tables.edge });
    const f = quoteIdent(this.tables.feedback);
    this.insertFeedback = db.prepare(`INSERT INTO ${f} (bullet_ref, type, at, session_ref, reason) VALUES (?, ?, ?, ?, ?)`);
    this.feedbackByBullet = db.prepare(`SELECT * FROM ${f} WHERE bullet_ref = ? ORDER BY at, id`);
    this.allFeedback = db.prepare(`SELECT * FROM ${f} ORDER BY at, id`);
  }

  add(input: NewBullet): Bullet {
    const at = this.now().toISOString();
    const bullet = materialize(input, at);
    this.write(bullet);
    return bullet;
  }

  get(id: string): Bullet | undefined {
    const row = this.entities.get(bulletRef(id));
    return row === undefined || row.kind !== BULLET_KIND ? undefined : toBullet(row);
  }

  require(id: string): Bullet {
    const bullet = this.get(id);
    if (bullet === undefined) throw new BulletNotFound(id);
    return bullet;
  }

  /** Live bullets only, unless `includeRetired`; ordered by id for determinism. */
  list({ includeRetired = false }: { includeRetired?: boolean } = {}): Bullet[] {
    const all = this.entities.listByKind(BULLET_KIND).map(toBullet);
    return includeRetired ? all : all.filter((b) => b.state !== "retired");
  }

  update(id: string, patch: Partial<Omit<Bullet, "id" | "createdAt">>): Bullet {
    const next = { ...this.require(id), ...patch, updatedAt: this.now().toISOString() };
    this.write(next);
    return next;
  }

  /** Retire a bullet. With `replacedBy`, also assert `replacedBy -supersedes-> id`. */
  deprecate(id: string, reason: string, replacedBy: string | null = null): Bullet {
    const at = this.now().toISOString();
    const bullet = this.update(id, { state: "retired", maturity: "deprecated", replacedBy, deprecatedAt: at, deprecationReason: reason });
    if (replacedBy !== null) this.edges.assert({ sourceRef: bulletRef(replacedBy), relation: SUPERSEDES, targetRef: bulletRef(id), tValid: at });
    return bullet;
  }

  /** Ids of the bullets this one replaced, following live `supersedes` edges. */
  supersededBy(id: string): string[] {
    return this.edges.from(bulletRef(id)).filter((e) => e.relation === SUPERSEDES).map((e) => e.targetRef.slice("memory:".length));
  }

  recordFeedback(id: string, type: FeedbackType, input: FeedbackInput = {}): FeedbackEvent {
    this.require(id);
    const at = input.at ?? this.now().toISOString();
    const info = this.insertFeedback.run(bulletRef(id), type, at, input.sessionRef ?? null, input.reason ?? null);
    return { id: Number(info.lastInsertRowid), bulletId: id, type, at, sessionRef: input.sessionRef ?? null, reason: input.reason ?? null };
  }

  feedbackFor(id: string): FeedbackEvent[] {
    return (this.feedbackByBullet.all(bulletRef(id)) as RawFeedbackRow[]).map(toEvent);
  }

  /** Every event grouped by bullet id, one query, for scoring the whole playbook. */
  feedbackByBulletId(): Map<string, FeedbackEvent[]> {
    const grouped = new Map<string, FeedbackEvent[]>();
    for (const event of (this.allFeedback.all() as RawFeedbackRow[]).map(toEvent)) {
      const list = grouped.get(event.bulletId) ?? [];
      list.push(event);
      grouped.set(event.bulletId, list);
    }
    return grouped;
  }

  /** A content pattern a human has banned; the curator refuses to re-learn anything near it. */
  block(pattern: string, reason: string): BlockedPattern {
    const blockedAt = this.now().toISOString();
    this.entities.upsert({ ref: blockedRef(randomUUID()), kind: BLOCKED_KIND, name: pattern, attrs: { reason, blockedAt }, tValid: blockedAt });
    return { pattern, reason, blockedAt };
  }

  blockedPatterns(): BlockedPattern[] {
    return this.entities.listByKind(BLOCKED_KIND).map((row) => ({
      pattern: row.name ?? "",
      reason: String(row.attrs?.reason ?? ""),
      blockedAt: String(row.attrs?.blockedAt ?? row.tValid),
    }));
  }

  private write(bullet: Bullet): void {
    const { id, content, category, ...attrs } = bullet;
    this.entities.upsert({ ref: bulletRef(id), kind: BULLET_KIND, name: category, attrs: { ...attrs, content }, tValid: bullet.createdAt });
  }
}

export function newBulletId(now: Date = new Date()): string {
  return `b-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function materialize(input: NewBullet, at: string): Bullet {
  return {
    id: input.id ?? newBulletId(new Date(at)),
    content: input.content,
    category: input.category ?? "general",
    tags: [...(input.tags ?? [])],
    scope: input.scope ?? "workspace",
    type: input.type ?? (input.isNegative ? "anti-pattern" : "rule"),
    kind: input.kind ?? (input.isNegative ? "anti_pattern" : "workflow_rule"),
    isNegative: input.isNegative ?? false,
    source: input.source ?? "learned",
    state: input.state ?? "active",
    maturity: "candidate",
    pinned: input.pinned ?? false,
    pinnedReason: input.pinnedReason ?? null,
    replacedBy: null,
    deprecatedAt: null,
    deprecationReason: null,
    halfLifeDays: input.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
    sourceSessions: [...(input.sourceSessions ?? [])],
    reasoning: input.reasoning ?? null,
    createdAt: at,
    updatedAt: at,
  };
}

function toBullet(row: EntityRow): Bullet {
  const attrs = (row.attrs ?? {}) as Attrs & { content: string };
  const { content, ...rest } = attrs;
  return { id: row.ref.slice("memory:".length), content, category: row.name ?? "general", ...rest };
}

function toEvent(raw: RawFeedbackRow): FeedbackEvent {
  return { id: raw.id, bulletId: raw.bullet_ref.slice("memory:".length), type: raw.type, at: raw.at, sessionRef: raw.session_ref, reason: raw.reason };
}
