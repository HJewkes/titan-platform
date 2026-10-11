import { z } from 'zod';

declare const METRICS_SCHEMA_ID = "titan.metrics/v1";
declare const AUDIT_SCHEMA_ID = "titan.measurement-audit/v1";
declare const METRIC_FAMILIES: readonly ["availability", "flow", "quality", "owner-load", "cost", "business"];
declare const METRIC_UNITS: readonly ["count", "ratio", "minutes", "hours", "usd", "tokens"];
declare const CADENCES: readonly ["1m", "1h", "1d", "1w"];
declare const SURFACES: readonly ["status", "stats", "health", "dashboard", "digest"];
type Mode = "write" | "read";
/** Write schemas refuse unknown keys; read schemas keep them so an older reader survives a newer writer. */
declare const metricsEntrySchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.metrics/v1">;
    area: z.ZodString;
    owner: z.ZodString;
    stores: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            sqlite: "sqlite";
            jsonl: "jsonl";
            log: "log";
            http: "http";
            cli: "cli";
        }>;
        path: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
        readonly: z.ZodLiteral<true>;
    }, z.core.$strip>>;
    metrics: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        family: z.ZodEnum<{
            availability: "availability";
            flow: "flow";
            quality: "quality";
            "owner-load": "owner-load";
            cost: "cost";
            business: "business";
        }>;
        title: z.ZodString;
        definition: z.ZodString;
        unit: z.ZodEnum<{
            count: "count";
            ratio: "ratio";
            minutes: "minutes";
            hours: "hours";
            usd: "usd";
            tokens: "tokens";
        }>;
        source: z.ZodObject<{
            anchor: z.ZodString;
            store: z.ZodString;
            captured: z.ZodEnum<{
                Y: "Y";
                P: "P";
                N: "N";
            }>;
            gapSlice: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        query: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                http: "http";
                cli: "cli";
                sql: "sql";
            }>;
            store: z.ZodString;
            text: z.ZodString;
            valuePath: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        cadence: z.ZodEnum<{
            "1m": "1m";
            "1h": "1h";
            "1d": "1d";
            "1w": "1w";
        }>;
        slo: z.ZodOptional<z.ZodObject<{
            objective: z.ZodString;
            target: z.ZodNumber;
            op: z.ZodEnum<{
                "<=": "<=";
                ">=": ">=";
                between: "between";
            }>;
            window: z.ZodEnum<{
                "1d": "1d";
                "7d": "7d";
                "28d": "28d";
            }>;
            alert: z.ZodObject<{
                threshold: z.ZodNumber;
                sustain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodEnum<{
            status: "status";
            stats: "stats";
            health: "health";
            dashboard: "dashboard";
            digest: "digest";
        }>>;
        answers: z.ZodArray<z.ZodNumber>;
    }, z.core.$strip>>;
    reports: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        metrics: z.ZodArray<z.ZodString>;
        view: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    lastAudit: z.ZodObject<{
        at: z.ZodString;
        codeRev: z.ZodString;
        report: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const metricsEntryReadSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.metrics/v1">;
    area: z.ZodString;
    owner: z.ZodString;
    stores: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            sqlite: "sqlite";
            jsonl: "jsonl";
            log: "log";
            http: "http";
            cli: "cli";
        }>;
        path: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
        readonly: z.ZodLiteral<true>;
    }, z.core.$strip>>;
    metrics: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        family: z.ZodEnum<{
            availability: "availability";
            flow: "flow";
            quality: "quality";
            "owner-load": "owner-load";
            cost: "cost";
            business: "business";
        }>;
        title: z.ZodString;
        definition: z.ZodString;
        unit: z.ZodEnum<{
            count: "count";
            ratio: "ratio";
            minutes: "minutes";
            hours: "hours";
            usd: "usd";
            tokens: "tokens";
        }>;
        source: z.ZodObject<{
            anchor: z.ZodString;
            store: z.ZodString;
            captured: z.ZodEnum<{
                Y: "Y";
                P: "P";
                N: "N";
            }>;
            gapSlice: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        query: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                http: "http";
                cli: "cli";
                sql: "sql";
            }>;
            store: z.ZodString;
            text: z.ZodString;
            valuePath: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        cadence: z.ZodEnum<{
            "1m": "1m";
            "1h": "1h";
            "1d": "1d";
            "1w": "1w";
        }>;
        slo: z.ZodOptional<z.ZodObject<{
            objective: z.ZodString;
            target: z.ZodNumber;
            op: z.ZodEnum<{
                "<=": "<=";
                ">=": ">=";
                between: "between";
            }>;
            window: z.ZodEnum<{
                "1d": "1d";
                "7d": "7d";
                "28d": "28d";
            }>;
            alert: z.ZodObject<{
                threshold: z.ZodNumber;
                sustain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodEnum<{
            status: "status";
            stats: "stats";
            health: "health";
            dashboard: "dashboard";
            digest: "digest";
        }>>;
        answers: z.ZodArray<z.ZodNumber>;
    }, z.core.$strip>>;
    reports: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        metrics: z.ZodArray<z.ZodString>;
        view: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    lastAudit: z.ZodObject<{
        at: z.ZodString;
        codeRev: z.ZodString;
        report: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const measurementAuditSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.measurement-audit/v1">;
    system: z.ZodString;
    mode: z.ZodEnum<{
        initial: "initial";
        reaudit: "reaudit";
    }>;
    at: z.ZodString;
    codeRev: z.ZodString;
    inputs: z.ZodObject<{
        system: z.ZodString;
        codeRoots: z.ZodArray<z.ZodString>;
        stores: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                sqlite: "sqlite";
                jsonl: "jsonl";
                log: "log";
                http: "http";
                cli: "cli";
            }>;
            path: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            command: z.ZodOptional<z.ZodString>;
            readonly: z.ZodLiteral<true>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                digest: "digest";
                http: "http";
                cli: "cli";
                view: "view";
            }>;
            ref: z.ZodString;
        }, z.core.$strip>>;
        sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
        owner: z.ZodString;
        mode: z.ZodEnum<{
            initial: "initial";
            reaudit: "reaudit";
        }>;
    }, z.core.$strip>;
    inventory: z.ZodObject<{
        data: z.ZodUnknown;
        emitters: z.ZodUnknown;
    }, z.core.$strip>;
    purpose: z.ZodString;
    users: z.ZodArray<z.ZodString>;
    questions: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        text: z.ZodString;
        answerable: z.ZodEnum<{
            yes: "yes";
            partly: "partly";
            no: "no";
        }>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metrics: z.ZodArray<z.ZodObject<{
        baseline: z.ZodOptional<z.ZodObject<{
            value: z.ZodNullable<z.ZodNumber>;
            n: z.ZodNumber;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        id: z.ZodString;
        family: z.ZodEnum<{
            availability: "availability";
            flow: "flow";
            quality: "quality";
            "owner-load": "owner-load";
            cost: "cost";
            business: "business";
        }>;
        title: z.ZodString;
        definition: z.ZodString;
        unit: z.ZodEnum<{
            count: "count";
            ratio: "ratio";
            minutes: "minutes";
            hours: "hours";
            usd: "usd";
            tokens: "tokens";
        }>;
        source: z.ZodObject<{
            anchor: z.ZodString;
            store: z.ZodString;
            captured: z.ZodEnum<{
                Y: "Y";
                P: "P";
                N: "N";
            }>;
            gapSlice: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        query: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                http: "http";
                cli: "cli";
                sql: "sql";
            }>;
            store: z.ZodString;
            text: z.ZodString;
            valuePath: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        cadence: z.ZodEnum<{
            "1m": "1m";
            "1h": "1h";
            "1d": "1d";
            "1w": "1w";
        }>;
        slo: z.ZodOptional<z.ZodObject<{
            objective: z.ZodString;
            target: z.ZodNumber;
            op: z.ZodEnum<{
                "<=": "<=";
                ">=": ">=";
                between: "between";
            }>;
            window: z.ZodEnum<{
                "1d": "1d";
                "7d": "7d";
                "28d": "28d";
            }>;
            alert: z.ZodObject<{
                threshold: z.ZodNumber;
                sustain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodEnum<{
            status: "status";
            stats: "stats";
            health: "health";
            dashboard: "dashboard";
            digest: "digest";
        }>>;
        answers: z.ZodArray<z.ZodNumber>;
    }, z.core.$strip>>;
    counts: z.ZodObject<{
        proposed: z.ZodNumber;
        Y: z.ZodNumber;
        P: z.ZodNumber;
        N: z.ZodNumber;
        slices: z.ZodNumber;
    }, z.core.$strip>;
    gaps: z.ZodArray<z.ZodObject<{
        rank: z.ZodNumber;
        metric: z.ZodArray<z.ZodString>;
        slice: z.ZodObject<{
            title: z.ZodString;
            done_when: z.ZodString;
            estimate: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    reports: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        metrics: z.ZodArray<z.ZodString>;
        view: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    drift: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    extra: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
declare const measurementAuditReadSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.measurement-audit/v1">;
    system: z.ZodString;
    mode: z.ZodEnum<{
        initial: "initial";
        reaudit: "reaudit";
    }>;
    at: z.ZodString;
    codeRev: z.ZodString;
    inputs: z.ZodObject<{
        system: z.ZodString;
        codeRoots: z.ZodArray<z.ZodString>;
        stores: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodEnum<{
                sqlite: "sqlite";
                jsonl: "jsonl";
                log: "log";
                http: "http";
                cli: "cli";
            }>;
            path: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            command: z.ZodOptional<z.ZodString>;
            readonly: z.ZodLiteral<true>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                digest: "digest";
                http: "http";
                cli: "cli";
                view: "view";
            }>;
            ref: z.ZodString;
        }, z.core.$strip>>;
        sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
        owner: z.ZodString;
        mode: z.ZodEnum<{
            initial: "initial";
            reaudit: "reaudit";
        }>;
    }, z.core.$strip>;
    inventory: z.ZodObject<{
        data: z.ZodUnknown;
        emitters: z.ZodUnknown;
    }, z.core.$strip>;
    purpose: z.ZodString;
    users: z.ZodArray<z.ZodString>;
    questions: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        text: z.ZodString;
        answerable: z.ZodEnum<{
            yes: "yes";
            partly: "partly";
            no: "no";
        }>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metrics: z.ZodArray<z.ZodObject<{
        baseline: z.ZodOptional<z.ZodObject<{
            value: z.ZodNullable<z.ZodNumber>;
            n: z.ZodNumber;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        id: z.ZodString;
        family: z.ZodEnum<{
            availability: "availability";
            flow: "flow";
            quality: "quality";
            "owner-load": "owner-load";
            cost: "cost";
            business: "business";
        }>;
        title: z.ZodString;
        definition: z.ZodString;
        unit: z.ZodEnum<{
            count: "count";
            ratio: "ratio";
            minutes: "minutes";
            hours: "hours";
            usd: "usd";
            tokens: "tokens";
        }>;
        source: z.ZodObject<{
            anchor: z.ZodString;
            store: z.ZodString;
            captured: z.ZodEnum<{
                Y: "Y";
                P: "P";
                N: "N";
            }>;
            gapSlice: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        query: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                http: "http";
                cli: "cli";
                sql: "sql";
            }>;
            store: z.ZodString;
            text: z.ZodString;
            valuePath: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        cadence: z.ZodEnum<{
            "1m": "1m";
            "1h": "1h";
            "1d": "1d";
            "1w": "1w";
        }>;
        slo: z.ZodOptional<z.ZodObject<{
            objective: z.ZodString;
            target: z.ZodNumber;
            op: z.ZodEnum<{
                "<=": "<=";
                ">=": ">=";
                between: "between";
            }>;
            window: z.ZodEnum<{
                "1d": "1d";
                "7d": "7d";
                "28d": "28d";
            }>;
            alert: z.ZodObject<{
                threshold: z.ZodNumber;
                sustain: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        surfaces: z.ZodArray<z.ZodEnum<{
            status: "status";
            stats: "stats";
            health: "health";
            dashboard: "dashboard";
            digest: "digest";
        }>>;
        answers: z.ZodArray<z.ZodNumber>;
    }, z.core.$strip>>;
    counts: z.ZodObject<{
        proposed: z.ZodNumber;
        Y: z.ZodNumber;
        P: z.ZodNumber;
        N: z.ZodNumber;
        slices: z.ZodNumber;
    }, z.core.$strip>;
    gaps: z.ZodArray<z.ZodObject<{
        rank: z.ZodNumber;
        metric: z.ZodArray<z.ZodString>;
        slice: z.ZodObject<{
            title: z.ZodString;
            done_when: z.ZodString;
            estimate: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    reports: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        metrics: z.ZodArray<z.ZodString>;
        view: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    drift: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    extra: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
type MetricsEntry = z.infer<typeof metricsEntrySchema>;
type MetricSpec = MetricsEntry["metrics"][number];
type MeasurementAudit = z.infer<typeof measurementAuditSchema>;
type MetricsEntryRead = z.infer<typeof metricsEntryReadSchema>;
type MeasurementAuditRead = z.infer<typeof measurementAuditReadSchema>;
type ValidateResult<T> = {
    ok: true;
    entry: T;
} | {
    ok: false;
    errors: string[];
};
/** Picks the schema by the entry's own `schema` id, so one call covers registry entries and audit reports. */
declare function validateEntry(input: unknown, mode: Mode): ValidateResult<MetricsEntry | MeasurementAudit | MetricsEntryRead | MeasurementAuditRead>;

export { AUDIT_SCHEMA_ID, CADENCES, METRICS_SCHEMA_ID, METRIC_FAMILIES, METRIC_UNITS, type MeasurementAudit, type MeasurementAuditRead, type MetricSpec, type MetricsEntry, type MetricsEntryRead, SURFACES, type ValidateResult, measurementAuditReadSchema, measurementAuditSchema, metricsEntryReadSchema, metricsEntrySchema, validateEntry };
