import { Migration, Db } from '@titan-design/store-sqlite';
import { ExecutionRecord, ExecutionTransition } from '@titan-design/agent-protocol';

declare const DEFAULT_EXECUTION_TABLE = "agent_execution";
/** Authoritative execution state is separate from rebuildable transcript indexes. */
declare function executionLedgerDdl(name?: string): string;
declare function executionLedgerMigration(version: number, name?: string): Migration;

type ApplyExecutionTransitionResult<TResult = unknown> = {
    ok: true;
    applied: boolean;
    record: ExecutionRecord<TResult>;
} | {
    ok: false;
    kind: "not_found" | "revision_conflict" | "event_conflict" | "invalid_transition" | "ownership_lost";
    reason: string;
    current?: ExecutionRecord<TResult>;
};
interface ExecutionLedger<TResult = unknown> {
    get(executionId: string): ExecutionRecord<TResult> | undefined;
    findByRequestKey(requestKey: string): ExecutionRecord<TResult> | undefined;
    listRecoverable(limit?: number): ExecutionRecord<TResult>[];
    apply(transition: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult>;
    events(executionId: string): readonly ExecutionTransition<TResult>[];
}
interface SqliteExecutionLedgerOptions {
    table?: string;
    /** Trusted ledger clock, distinct from a caller-supplied event timestamp. */
    now?: () => string;
    /** Receives one line per stored row `listRecoverable` skips; defaults to `console.warn`. */
    warn?: (line: string) => void;
}

/** Immediate transactions commit a validated snapshot and its immutable receipt together. */
declare class SqliteExecutionLedger<TResult = unknown> implements ExecutionLedger<TResult> {
    private readonly db;
    private readonly snapshot;
    private readonly eventTable;
    private readonly now;
    private readonly warn;
    private readonly recordSchema;
    private readonly transitionSchema;
    constructor(db: Db, options?: SqliteExecutionLedgerOptions);
    get(executionId: string): ExecutionRecord<TResult> | undefined;
    findByRequestKey(requestKey: string): ExecutionRecord<TResult> | undefined;
    listRecoverable(limit?: number): ExecutionRecord<TResult>[];
    /** Recovery must reach every other execution, so one unreadable row is logged and skipped rather than thrown. */
    private recoverableRecord;
    events(executionId: string): ExecutionTransition<TResult>[];
    apply(transition: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult>;
    private applyInside;
    private validateLiveTransition;
    private save;
    private decode;
    private parseRecord;
}

export { type ApplyExecutionTransitionResult, DEFAULT_EXECUTION_TABLE, type ExecutionLedger, SqliteExecutionLedger, type SqliteExecutionLedgerOptions, executionLedgerDdl, executionLedgerMigration };
