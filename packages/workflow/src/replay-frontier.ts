import { WorkflowRecoveryRequiredError, type StepOperation, type StepResult, type WorkflowRun } from "./types.js";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The results a prior drive recorded, tracked as this drive's replay reads them. A live call made while some are unread
 * means the replay took a path the record does not hold, unless a concurrent branch is still catching up.
 */
export class ReplayFrontier {
  private readonly pending: Set<string>;
  private readonly order: readonly string[];
  private reads = 0;

  constructor(recordedKeys: readonly string[]) {
    this.order = recordedKeys;
    this.pending = new Set(recordedKeys);
  }

  read(key: string): void {
    if (this.pending.delete(key)) this.reads += 1;
  }

  unread(): number {
    return this.pending.size;
  }

  /** The first unread result in recording order. */
  nextUnread(): string | undefined {
    return this.order.find((key) => this.pending.has(key));
  }

  /** Waits while turns keep reading records; true once every record is read, false when a turn reads none. */
  async settled(): Promise<boolean> {
    while (this.pending.size > 0) {
      const before = this.reads;
      await nextTurn();
      if (this.reads === before) return this.pending.size === 0;
    }
    return true;
  }

  evidence(operation: StepOperation, stepId: string): string {
    return `replay diverged: ${operation}("${stepId}") ran live with ${this.unread()} recorded results unread, next ${this.nextUnread()}`;
  }
}

/**
 * Strict replay for one drive: reads memos through the frontier and refuses a live call the record cannot explain.
 * The refusal is sticky, so workflow code that catches it cannot carry on from the record.
 */
export class ReplayGuard {
  private readonly frontier: ReplayFrontier | null;
  private diverged: string | null = null;

  constructor(
    private readonly run: WorkflowRun,
    strict: boolean,
    private readonly hold: (stepId: string, evidence: string) => never,
  ) {
    this.frontier = strict ? new ReplayFrontier(Object.keys(run.stepResults)) : null;
  }

  /** The result recorded at `key`, or else at `otherKey`, marking whichever answered as read. */
  recall(stepId: string, key: string, otherKey: string | undefined): StepResult | undefined {
    this.throwIfDiverged(stepId);
    const foundAt = this.run.stepResults[key] !== undefined || otherKey === undefined ? key : otherKey;
    const cached = this.run.stepResults[foundAt];
    if (cached) this.frontier?.read(foundAt);
    return cached;
  }

  unread(): number {
    return this.frontier?.unread() ?? 0;
  }

  /** Parks the run, before the live call has any side effect, when records stay unread after concurrent branches settle. */
  async beforeLive(operation: StepOperation, stepId: string): Promise<void> {
    if (!this.frontier || (await this.frontier.settled())) return;
    this.throwIfDiverged(stepId);
    this.diverged = this.frontier.evidence(operation, stepId);
    this.hold(stepId, this.diverged);
  }

  private throwIfDiverged(stepId: string): void {
    if (this.diverged !== null) throw new WorkflowRecoveryRequiredError(this.run.id, stepId, this.diverged);
  }
}
