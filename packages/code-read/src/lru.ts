/** A least-recently-used cache; Map iteration order is insertion order, so the first key is the eldest. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`LRU capacity must be a positive integer, got ${capacity}`);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** The cached value, refreshed to most recent; otherwise `load`'s value, evicting the eldest when full. */
  getOrLoad(key: K, load: () => V): V {
    if (this.entries.has(key)) {
      const value = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, value);
      return value;
    }
    const value = load();
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }
}
