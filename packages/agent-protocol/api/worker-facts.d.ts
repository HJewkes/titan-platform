import { z } from 'zod';

declare const MAX_WORKER_REPORT_LENGTH = 2000;
/** What a spawned worker's completion carries. A no-report exit is valid and has only exit facts. */
declare const WorkerFactsSchema: z.ZodObject<{
    agent: z.ZodString;
    profile: z.ZodString;
    spawner: z.ZodString;
    taskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    report: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        messageId: z.ZodString;
        kind: z.ZodEnum<{
            status: "status";
            verdict: "verdict";
        }>;
        text: z.ZodString;
    }, z.core.$strict>>>;
    pr: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        repo: z.ZodString;
        number: z.ZodNumber;
    }, z.core.$strict>>>;
    tokens: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        input: z.ZodNumber;
        output: z.ZodNumber;
        total: z.ZodNumber;
    }, z.core.$strict>>>;
    costUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    exit: z.ZodObject<{
        code: z.ZodNullable<z.ZodNumber>;
        signal: z.ZodNullable<z.ZodString>;
        inferred: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>;
type WorkerFacts = z.infer<typeof WorkerFactsSchema>;

export { MAX_WORKER_REPORT_LENGTH, type WorkerFacts, WorkerFactsSchema };
