type Role = "user" | "assistant";

interface PendingEntry<T> {
  role: Role;
  text: string;
  item: T;
}

/**
 * Decides, for one Codex turn, which high-level message projections a raw response message supersedes.
 * The rule holds in either arrival order: a projection is suppressed by an earlier canonical message
 * and a canonical message removes a projection that is already pending. Call `drain` at a turn end.
 */
export class CodexProjectionBuffer<T> {
  private pending: PendingEntry<T>[] = [];
  private readonly canonicalSeen = new Map<string, number>();

  first(): T | null {
    return this.pending[0]?.item ?? null;
  }

  /** Returns false when an earlier canonical message already covers this projection. */
  addProjection(role: Role, text: string, item: T): boolean {
    const key = canonicalKey(role, text);
    const seen = this.canonicalSeen.get(key) ?? 0;
    if (seen > 0) {
      this.canonicalSeen.set(key, seen - 1);
      return false;
    }
    this.pending.push({ role, text, item });
    return true;
  }

  /** Returns the pending projection this canonical message supersedes, if any. */
  addCanonical(role: Role, text: string): T | null {
    const index = this.pending.findIndex((entry) => entry.role === role && entry.text === text);
    if (index >= 0) return this.pending.splice(index, 1)[0]!.item;
    const key = canonicalKey(role, text);
    this.canonicalSeen.set(key, (this.canonicalSeen.get(key) ?? 0) + 1);
    return null;
  }

  drain(): T[] {
    this.canonicalSeen.clear();
    return this.pending.splice(0).map((entry) => entry.item);
  }
}

function canonicalKey(role: Role, text: string): string {
  return `${role}\u0000${text}`;
}
