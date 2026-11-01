import { z } from 'zod';
import { ExecutionRecord, ExecutionTransition } from './index.js';

/** Reads an execution record from storage; `result` is the schema for the opaque terminal result. */
declare function executionRecordSchema<TResult>(result: z.ZodType<TResult>): z.ZodType<ExecutionRecord<TResult>>;
/** Reads a stored transition; `result` is the schema for the opaque terminal result of a `finish`. */
declare function executionTransitionSchema<TResult>(result: z.ZodType<TResult>): z.ZodType<ExecutionTransition<TResult>>;
/** Terminal results are opaque to the protocol; callers narrow them with their own schema. */
declare const ExecutionRecordSchema: z.ZodType<ExecutionRecord<unknown>, unknown, z.core.$ZodTypeInternals<ExecutionRecord<unknown>, unknown>>;
declare const ExecutionTransitionSchema: z.ZodType<ExecutionTransition<unknown>, unknown, z.core.$ZodTypeInternals<ExecutionTransition<unknown>, unknown>>;

export { ExecutionRecordSchema, ExecutionTransitionSchema, executionRecordSchema, executionTransitionSchema };
