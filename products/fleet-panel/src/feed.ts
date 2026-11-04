import type { EventBook } from "./events.js";
import type { AccountUsage, RosterEntry, Slots, StatusLineReading } from "./inputs.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { formatAge } from "./format.js";

/** Where a reconcile reads from; the node adapters live in `sources.ts`. */
export interface FeedSources {
  roster(): Promise<RosterEntry[]>;
  accounts(): Promise<AccountUsage[]>;
  slots(): Promise<Slots | null>;
  /** Null when the session has written no status line (a headless agent draws none). */
  statusLine(entry: RosterEntry): Promise<StatusLineReading | null>;
}

export interface FeedOptions {
  sources: FeedSources;
  book: EventBook;
  emit: (snapshot: Snapshot) => void;
  now: () => number;
  /** Errors from outside a reconcile, such as the event stream's, shown until it recovers. */
  streamError?: () => string | null;
}

interface Held<T> {
  value: T;
  atMs: number;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/**
 * Reads every source, builds a snapshot and emits it. A source that fails keeps its last good
 * value and says so with that value's age, so one failed read neither blanks the panel nor
 * passes an old roster off as current.
 */
export class Feed {
  private roster: Held<RosterEntry[]> | null = null;
  private accounts: Held<AccountUsage[]> | null = null;

  constructor(private readonly options: FeedOptions) {}

  async reconcile(): Promise<Snapshot> {
    const { sources, book, now } = this.options;
    const errors: string[] = [];
    const [roster, accounts, slots] = await Promise.allSettled([sources.roster(), sources.accounts(), sources.slots()]);
    this.roster = this.hold("roster", roster, this.roster, errors);
    this.accounts = this.hold("accounts", accounts, this.accounts, errors);
    if (slots.status === "rejected") errors.push(`broker health: ${reason(slots.reason)}`);
    const entries = this.roster?.value ?? [];
    const streamError = this.options.streamError?.();
    if (streamError) errors.push(`events: ${streamError}`);
    const snapshot = buildSnapshot({
      nowMs: now(),
      roster: entries,
      accounts: this.accounts?.value ?? [],
      statusLines: await this.statusLines(entries),
      reportOf: (name) => book.reportOf(name),
      taskOf: (name) => book.taskOf(name),
      slots: slots.status === "fulfilled" ? slots.value : null,
      errors,
    });
    this.options.emit(snapshot);
    return snapshot;
  }

  private hold<T>(label: string, result: PromiseSettledResult<T>, last: Held<T> | null, errors: string[]): Held<T> | null {
    if (result.status === "fulfilled") return { value: result.value, atMs: this.options.now() };
    const kept = last === null ? "" : ` (showing the read from ${formatAge(this.options.now() - last.atMs)} ago)`;
    errors.push(`${label}: ${reason(result.reason)}${kept}`);
    return last;
  }

  private async statusLines(entries: readonly RosterEntry[]): Promise<Map<string, StatusLineReading>> {
    const live = entries.filter((entry) => entry.presence !== "exited" && entry.sessionId !== "");
    const reads = await Promise.all(live.map((entry) => this.options.sources.statusLine(entry).catch(() => null)));
    const lines = new Map<string, StatusLineReading>();
    live.forEach((entry, i) => {
      const read = reads[i];
      if (read) lines.set(entry.sessionId, read);
    });
    return lines;
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface Timers {
  setTimeout(run: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/**
 * Runs `reconcile` every `pollMs`, and soon after a `poke` (a pushed event), but never two at
 * once and never more often than `minGapMs`.
 */
export class ReconcileSchedule {
  private timer: TimerHandle | null = null;
  private running = false;
  private again = false;
  private lastStartMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly reconcile: () => Promise<unknown>,
    private readonly options: { pollMs: number; minGapMs: number; now: () => number; timers: Timers },
  ) {}

  start(): void {
    void this.run();
  }

  poke(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    const wait = Math.max(0, this.lastStartMs + this.options.minGapMs - this.options.now());
    this.schedule(wait);
  }

  stop(): void {
    if (this.timer !== null) this.options.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = this.options.timers.setTimeout(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    this.stop();
    this.running = true;
    this.takeAgain();
    this.lastStartMs = this.options.now();
    try {
      await this.reconcile();
    } finally {
      this.running = false;
      this.schedule(this.takeAgain() ? this.options.minGapMs : this.options.pollMs);
    }
  }

  /** Whether a push arrived since the last call, clearing it. */
  private takeAgain(): boolean {
    const again = this.again;
    this.again = false;
    return again;
  }
}
