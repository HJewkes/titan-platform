import { z, ZodType } from 'zod';
import { violationExcess } from '@titan-design/code-graph/analysis';
import { JsonEnvelope } from '@titan-design/rpc-protocol';

/** The read API's semver. Bump it whenever `CONTRACT` changes; `contract.lock.json` records the last one. */
declare const CODE_READ_API_VERSION = "0.1.8";
interface CommandContract<Args extends ZodType = ZodType, Result extends ZodType = ZodType> {
    description: string;
    args: Args;
    result: Result;
}
/** The single source of command names, argument schemas, and result schemas for every surface. */
declare const CONTRACT: {
    readonly "api.describe": {
        readonly description: "Contract version, commands served, capabilities, the newest snapshot, and the metric and rule catalogues. Call first to pin compatibility.";
        readonly args: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            api: z.ZodString;
            dataset: z.ZodEnum<{
                live: "live";
                static: "static";
            }>;
            commands: z.ZodArray<z.ZodString>;
            newest: z.ZodNullable<z.ZodObject<{
                id: z.ZodNumber;
                ref: z.ZodString;
                commit: z.ZodNullable<z.ZodString>;
                takenAt: z.ZodString;
                indexVersion: z.ZodString;
            }, z.core.$strip>>;
            indexVersions: z.ZodArray<z.ZodString>;
            capabilities: z.ZodObject<{
                findings: z.ZodEnum<{
                    none: "none";
                    "check-rules": "check-rules";
                    store: "store";
                }>;
                verdicts: z.ZodBoolean;
                themes: z.ZodBoolean;
                feedback: z.ZodBoolean;
                embeddings: z.ZodNullable<z.ZodObject<{
                    model: z.ZodString;
                    embedded: z.ZodNumber;
                    symbols: z.ZodNumber;
                }, z.core.$strip>>;
                cochange: z.ZodBoolean;
                sourceAtCommit: z.ZodBoolean;
                excerpts: z.ZodEnum<{
                    any: "any";
                    none: "none";
                    flagged: "flagged";
                }>;
            }, z.core.$strip>;
            metrics: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                unit: z.ZodNullable<z.ZodString>;
                appliesTo: z.ZodArray<z.ZodString>;
                rollup: z.ZodEnum<{
                    sum: "sum";
                    max: "max";
                    mean: "mean";
                    none: "none";
                }>;
                direction: z.ZodEnum<{
                    "higher-worse": "higher-worse";
                    "lower-worse": "lower-worse";
                    neutral: "neutral";
                }>;
                absent: z.ZodEnum<{
                    zero: "zero";
                    exclude: "exclude";
                }>;
                window: z.ZodOptional<z.ZodString>;
                description: z.ZodString;
                provenance: z.ZodObject<{
                    kind: z.ZodEnum<{
                        measured: "measured";
                        derived: "derived";
                        model: "model";
                    }>;
                    source: z.ZodString;
                    at: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>>;
            rules: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                type: z.ZodString;
                severity: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly "snapshot.list": {
        readonly description: "Indexed snapshots, newest first, with ref, commit, time, and index version. Optionally one ref only.";
        readonly args: z.ZodObject<{
            ref: z.ZodOptional<z.ZodString>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            snapshots: z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                ref: z.ZodString;
                commit: z.ZodNullable<z.ZodString>;
                takenAt: z.ZodString;
                indexVersion: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly "hierarchy.get": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            root: z.ZodOptional<z.ZodString>;
            depth: z.ZodDefault<z.ZodNumber>;
            metrics: z.ZodDefault<z.ZodArray<z.ZodString>>;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            include_symbols: z.ZodDefault<z.ZodBoolean>;
            exclude_roles: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            nodes: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodString;
                name: z.ZodString;
                path: z.ZodString;
                span: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                parentId: z.ZodNullable<z.ZodString>;
                depth: z.ZodNumber;
                childCount: z.ZodNumber;
                role: z.ZodOptional<z.ZodString>;
                values: z.ZodRecord<z.ZodString, z.ZodNullable<z.ZodNumber>>;
                missing: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                deltas: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNullable<z.ZodNumber>>>;
            }, z.core.$strip>>;
            truncated: z.ZodBoolean;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "node.get": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            id: z.ZodString;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            metrics: z.ZodDefault<z.ZodArray<z.ZodString>>;
            lenses: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                score: "score";
                exports: "exports";
                centrality: "centrality";
                coupling: "coupling";
                tests: "tests";
            }>>>;
            window: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            node: z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodString;
                name: z.ZodString;
                path: z.ZodString;
                span: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                language: z.ZodOptional<z.ZodString>;
                role: z.ZodOptional<z.ZodString>;
                exported: z.ZodOptional<z.ZodBoolean>;
                signature: z.ZodOptional<z.ZodString>;
                purpose: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            ancestors: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodString;
                name: z.ZodString;
                path: z.ZodString;
                span: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
            childCounts: z.ZodRecord<z.ZodString, z.ZodNumber>;
            metrics: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                unit: z.ZodNullable<z.ZodString>;
                direction: z.ZodEnum<{
                    "higher-worse": "higher-worse";
                    "lower-worse": "lower-worse";
                    neutral: "neutral";
                }>;
                rollup: z.ZodEnum<{
                    sum: "sum";
                    max: "max";
                    mean: "mean";
                    none: "none";
                }>;
                value: z.ZodNullable<z.ZodNumber>;
                missing: z.ZodOptional<z.ZodString>;
                percentile: z.ZodNullable<z.ZodNumber>;
                siblingMedian: z.ZodNullable<z.ZodNumber>;
                siblingRank: z.ZodNullable<z.ZodNumber>;
                siblingCount: z.ZodNumber;
                baseline: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                delta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>>;
            lenses: z.ZodOptional<z.ZodObject<{
                exports: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    utilization: z.ZodNumber;
                    cognitive: z.ZodNullable<z.ZodNumber>;
                    consumers: z.ZodNumber;
                    exported: z.ZodBoolean;
                }, z.core.$strip>>>>;
                score: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    grain: z.ZodEnum<{
                        symbol: "symbol";
                        file: "file";
                    }>;
                    window: z.ZodString;
                    score: z.ZodNumber;
                    churn: z.ZodOptional<z.ZodNumber>;
                    complexity: z.ZodOptional<z.ZodNumber>;
                    recency: z.ZodOptional<z.ZodNumber>;
                    utilization: z.ZodOptional<z.ZodNumber>;
                    rank: z.ZodNullable<z.ZodNumber>;
                    ranked: z.ZodNumber;
                }, z.core.$strip>>>;
                centrality: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    score: z.ZodNullable<z.ZodNumber>;
                    rank: z.ZodNullable<z.ZodNumber>;
                    of: z.ZodNumber;
                }, z.core.$strip>>>;
                coupling: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    measured: z.ZodBoolean;
                    partners: z.ZodArray<z.ZodObject<{
                        node: z.ZodObject<{
                            id: z.ZodString;
                            kind: z.ZodString;
                            name: z.ZodString;
                            path: z.ZodString;
                            span: z.ZodOptional<z.ZodObject<{
                                startLine: z.ZodNumber;
                                endLine: z.ZodNumber;
                            }, z.core.$strip>>;
                        }, z.core.$strip>;
                        count: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>>>;
                tests: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    tests: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>;
                    indexedCount: z.ZodNullable<z.ZodNumber>;
                    coEditMeasured: z.ZodBoolean;
                }, z.core.$strip>>>;
            }, z.core.$strip>>;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "node.resolve": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            query: z.ZodOptional<z.ZodString>;
            path: z.ZodOptional<z.ZodString>;
            line: z.ZodOptional<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            candidates: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                score: z.ZodNumber;
                match: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly "findings.list": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            scope: z.ZodOptional<z.ZodString>;
            rule: z.ZodDefault<z.ZodArray<z.ZodString>>;
            severity: z.ZodDefault<z.ZodArray<z.ZodString>>;
            tool: z.ZodDefault<z.ZodArray<z.ZodString>>;
            provenance: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                measured: "measured";
                derived: "derived";
                model: "model";
            }>>>;
            kind: z.ZodDefault<z.ZodArray<z.ZodString>>;
            status: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                new: "new";
                carryover: "carryover";
                resolved: "resolved";
                worsened: "worsened";
                improved: "improved";
            }>>>;
            sort: z.ZodDefault<z.ZodEnum<{
                severity: "severity";
                value: "value";
                path: "path";
                excess: "excess";
                rule: "rule";
            }>>;
            order: z.ZodDefault<z.ZodEnum<{
                asc: "asc";
                desc: "desc";
            }>>;
            offset: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
            facets: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            rows: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                snapshotId: z.ZodNumber;
                rule: z.ZodString;
                tool: z.ZodString;
                severity: z.ZodString;
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                destination: z.ZodOptional<z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>>;
                range: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                metric: z.ZodOptional<z.ZodString>;
                value: z.ZodOptional<z.ZodNumber>;
                threshold: z.ZodOptional<z.ZodNumber>;
                excess: z.ZodNullable<z.ZodNumber>;
                status: z.ZodOptional<z.ZodEnum<{
                    new: "new";
                    carryover: "carryover";
                    resolved: "resolved";
                    worsened: "worsened";
                    improved: "improved";
                }>>;
                message: z.ZodString;
                provenance: z.ZodObject<{
                    kind: z.ZodEnum<{
                        measured: "measured";
                        derived: "derived";
                        model: "model";
                    }>;
                    source: z.ZodString;
                    at: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>>;
            total: z.ZodNumber;
            facets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodNumber>>>;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "finding.get": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            id: z.ZodString;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            context_lines: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            finding: z.ZodObject<{
                id: z.ZodString;
                snapshotId: z.ZodNumber;
                rule: z.ZodString;
                tool: z.ZodString;
                severity: z.ZodString;
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                destination: z.ZodOptional<z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>>;
                range: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                metric: z.ZodOptional<z.ZodString>;
                value: z.ZodOptional<z.ZodNumber>;
                threshold: z.ZodOptional<z.ZodNumber>;
                excess: z.ZodNullable<z.ZodNumber>;
                status: z.ZodOptional<z.ZodEnum<{
                    new: "new";
                    carryover: "carryover";
                    resolved: "resolved";
                    worsened: "worsened";
                    improved: "improved";
                }>>;
                message: z.ZodString;
                provenance: z.ZodObject<{
                    kind: z.ZodEnum<{
                        measured: "measured";
                        derived: "derived";
                        model: "model";
                    }>;
                    source: z.ZodString;
                    at: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>;
            rule: z.ZodObject<{
                id: z.ZodString;
                type: z.ZodString;
                severity: z.ZodString;
                text: z.ZodString;
            }, z.core.$strip>;
            measured: z.ZodObject<{
                value: z.ZodNullable<z.ZodNumber>;
                threshold: z.ZodNullable<z.ZodNumber>;
                percentile: z.ZodNullable<z.ZodNumber>;
                siblingMedian: z.ZodNullable<z.ZodNumber>;
                baselineValue: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>;
            why: z.ZodString;
            excerpt: z.ZodNullable<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
                text: z.ZodString;
                contentHash: z.ZodString;
                origin: z.ZodEnum<{
                    commit: "commit";
                    worktree: "worktree";
                    export: "export";
                }>;
                highlights: z.ZodArray<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                truncated: z.ZodBoolean;
            }, z.core.$strip>>;
            excerptMissing: z.ZodOptional<z.ZodString>;
            related: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                snapshotId: z.ZodNumber;
                rule: z.ZodString;
                tool: z.ZodString;
                severity: z.ZodString;
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                destination: z.ZodOptional<z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>>;
                range: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
                metric: z.ZodOptional<z.ZodString>;
                value: z.ZodOptional<z.ZodNumber>;
                threshold: z.ZodOptional<z.ZodNumber>;
                excess: z.ZodNullable<z.ZodNumber>;
                status: z.ZodOptional<z.ZodEnum<{
                    new: "new";
                    carryover: "carryover";
                    resolved: "resolved";
                    worsened: "worsened";
                    improved: "improved";
                }>>;
                message: z.ZodString;
                provenance: z.ZodObject<{
                    kind: z.ZodEnum<{
                        measured: "measured";
                        derived: "derived";
                        model: "model";
                    }>;
                    source: z.ZodString;
                    at: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>;
            }, z.core.$strip>>;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "node.neighbors": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            id: z.ZodString;
            direction: z.ZodDefault<z.ZodEnum<{
                out: "out";
                in: "in";
                both: "both";
            }>>;
            edge_kinds: z.ZodDefault<z.ZodArray<z.ZodString>>;
            metrics: z.ZodDefault<z.ZodArray<z.ZodString>>;
            offset: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            snapshotId: z.ZodNumber;
            node: z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodString;
                name: z.ZodString;
                path: z.ZodString;
                span: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            inbound: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                kind: z.ZodString;
                weight: z.ZodNullable<z.ZodNumber>;
                specifier: z.ZodOptional<z.ZodString>;
                values: z.ZodRecord<z.ZodString, z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>>;
            outbound: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                kind: z.ZodString;
                weight: z.ZodNullable<z.ZodNumber>;
                specifier: z.ZodOptional<z.ZodString>;
                values: z.ZodRecord<z.ZodString, z.ZodNullable<z.ZodNumber>>;
            }, z.core.$strip>>;
            total: z.ZodObject<{
                inbound: z.ZodNumber;
                outbound: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly "hotspots.list": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            grain: z.ZodDefault<z.ZodEnum<{
                symbol: "symbol";
                file: "file";
            }>>;
            window: z.ZodDefault<z.ZodString>;
            cutoff: z.ZodOptional<z.ZodNumber>;
            offset: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            rows: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                churn: z.ZodNumber;
                complexity: z.ZodNumber;
                recency: z.ZodNumber;
                score: z.ZodNumber;
                utilization: z.ZodOptional<z.ZodNumber>;
                baselineScore: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                mark: z.ZodOptional<z.ZodEnum<{
                    new: "new";
                    worsened: "worsened";
                }>>;
            }, z.core.$strip>>;
            total: z.ZodNumber;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "overview.get": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            window: z.ZodDefault<z.ZodString>;
            cutoff: z.ZodDefault<z.ZodNumber>;
            weights: z.ZodPrefault<z.ZodObject<{
                hotspots: z.ZodPrefault<z.ZodObject<{
                    each: z.ZodDefault<z.ZodNumber>;
                    cap: z.ZodDefault<z.ZodNumber>;
                }, z.core.$strip>>;
                findings: z.ZodPrefault<z.ZodObject<{
                    each_new: z.ZodDefault<z.ZodNumber>;
                    each_carry: z.ZodDefault<z.ZodNumber>;
                    cap: z.ZodDefault<z.ZodNumber>;
                }, z.core.$strip>>;
                complexity: z.ZodPrefault<z.ZodObject<{
                    budget: z.ZodDefault<z.ZodNumber>;
                    each: z.ZodDefault<z.ZodNumber>;
                    cap: z.ZodDefault<z.ZodNumber>;
                }, z.core.$strip>>;
                hidden_coupling: z.ZodPrefault<z.ZodObject<{
                    each: z.ZodDefault<z.ZodNumber>;
                    cap: z.ZodDefault<z.ZodNumber>;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
            exclude_rules: z.ZodDefault<z.ZodArray<z.ZodString>>;
            combined: z.ZodDefault<z.ZodBoolean>;
            reading_limit: z.ZodDefault<z.ZodNumber>;
            look_limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            kpis: z.ZodObject<{
                hotspotsOverCutoff: z.ZodNumber;
                maxComplexity: z.ZodNumber;
                knowledgeSilos: z.ZodNumber;
                findings: z.ZodObject<{
                    open: z.ZodNumber;
                    new: z.ZodOptional<z.ZodNumber>;
                    carryover: z.ZodOptional<z.ZodNumber>;
                    resolved: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>;
            }, z.core.$strip>;
            signals: z.ZodArray<z.ZodObject<{
                key: z.ZodEnum<{
                    findings: "findings";
                    complexity: "complexity";
                    hotspots: "hotspots";
                    "hidden-coupling": "hidden-coupling";
                }>;
                label: z.ZodString;
                penalty: z.ZodNumber;
                cap: z.ZodNumber;
                measured: z.ZodBoolean;
                detail: z.ZodString;
            }, z.core.$strip>>;
            combined: z.ZodOptional<z.ZodNumber>;
            readingOrder: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                centrality: z.ZodNumber;
            }, z.core.$strip>>;
            lookFirst: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                score: z.ZodNumber;
                churn: z.ZodNumber;
                complexity: z.ZodNumber;
                recency: z.ZodNumber;
                reasons: z.ZodArray<z.ZodEnum<{
                    findings: "findings";
                    "over-cutoff": "over-cutoff";
                    "churn-complexity": "churn-complexity";
                }>>;
            }, z.core.$strip>>;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "changes.get": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            baseline: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
            window: z.ZodDefault<z.ZodString>;
            cutoff: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            snapshotId: z.ZodNumber;
            baselineSnapshotId: z.ZodNumber;
            comparable: z.ZodBoolean;
            files: z.ZodObject<{
                crossedCutoff: z.ZodArray<z.ZodObject<{
                    node: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    before: z.ZodNumber;
                    after: z.ZodNumber;
                    delta: z.ZodNumber;
                }, z.core.$strip>>;
                added: z.ZodArray<z.ZodObject<{
                    node: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    score: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            findings: z.ZodObject<{
                new: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    snapshotId: z.ZodNumber;
                    rule: z.ZodString;
                    tool: z.ZodString;
                    severity: z.ZodString;
                    node: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    destination: z.ZodOptional<z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>;
                    range: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                    metric: z.ZodOptional<z.ZodString>;
                    value: z.ZodOptional<z.ZodNumber>;
                    threshold: z.ZodOptional<z.ZodNumber>;
                    excess: z.ZodNullable<z.ZodNumber>;
                    status: z.ZodOptional<z.ZodEnum<{
                        new: "new";
                        carryover: "carryover";
                        resolved: "resolved";
                        worsened: "worsened";
                        improved: "improved";
                    }>>;
                    message: z.ZodString;
                    provenance: z.ZodObject<{
                        kind: z.ZodEnum<{
                            measured: "measured";
                            derived: "derived";
                            model: "model";
                        }>;
                        source: z.ZodString;
                        at: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>>;
                worsened: z.ZodArray<z.ZodObject<{
                    finding: z.ZodObject<{
                        id: z.ZodString;
                        snapshotId: z.ZodNumber;
                        rule: z.ZodString;
                        tool: z.ZodString;
                        severity: z.ZodString;
                        node: z.ZodObject<{
                            id: z.ZodString;
                            kind: z.ZodString;
                            name: z.ZodString;
                            path: z.ZodString;
                            span: z.ZodOptional<z.ZodObject<{
                                startLine: z.ZodNumber;
                                endLine: z.ZodNumber;
                            }, z.core.$strip>>;
                        }, z.core.$strip>;
                        destination: z.ZodOptional<z.ZodObject<{
                            id: z.ZodString;
                            kind: z.ZodString;
                            name: z.ZodString;
                            path: z.ZodString;
                            span: z.ZodOptional<z.ZodObject<{
                                startLine: z.ZodNumber;
                                endLine: z.ZodNumber;
                            }, z.core.$strip>>;
                        }, z.core.$strip>>;
                        range: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                        metric: z.ZodOptional<z.ZodString>;
                        value: z.ZodOptional<z.ZodNumber>;
                        threshold: z.ZodOptional<z.ZodNumber>;
                        excess: z.ZodNullable<z.ZodNumber>;
                        status: z.ZodOptional<z.ZodEnum<{
                            new: "new";
                            carryover: "carryover";
                            resolved: "resolved";
                            worsened: "worsened";
                            improved: "improved";
                        }>>;
                        message: z.ZodString;
                        provenance: z.ZodObject<{
                            kind: z.ZodEnum<{
                                measured: "measured";
                                derived: "derived";
                                model: "model";
                            }>;
                            source: z.ZodString;
                            at: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>;
                    }, z.core.$strip>;
                    before: z.ZodNumber;
                    delta: z.ZodNumber;
                }, z.core.$strip>>;
                improved: z.ZodArray<z.ZodObject<{
                    finding: z.ZodObject<{
                        id: z.ZodString;
                        snapshotId: z.ZodNumber;
                        rule: z.ZodString;
                        tool: z.ZodString;
                        severity: z.ZodString;
                        node: z.ZodObject<{
                            id: z.ZodString;
                            kind: z.ZodString;
                            name: z.ZodString;
                            path: z.ZodString;
                            span: z.ZodOptional<z.ZodObject<{
                                startLine: z.ZodNumber;
                                endLine: z.ZodNumber;
                            }, z.core.$strip>>;
                        }, z.core.$strip>;
                        destination: z.ZodOptional<z.ZodObject<{
                            id: z.ZodString;
                            kind: z.ZodString;
                            name: z.ZodString;
                            path: z.ZodString;
                            span: z.ZodOptional<z.ZodObject<{
                                startLine: z.ZodNumber;
                                endLine: z.ZodNumber;
                            }, z.core.$strip>>;
                        }, z.core.$strip>>;
                        range: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                        metric: z.ZodOptional<z.ZodString>;
                        value: z.ZodOptional<z.ZodNumber>;
                        threshold: z.ZodOptional<z.ZodNumber>;
                        excess: z.ZodNullable<z.ZodNumber>;
                        status: z.ZodOptional<z.ZodEnum<{
                            new: "new";
                            carryover: "carryover";
                            resolved: "resolved";
                            worsened: "worsened";
                            improved: "improved";
                        }>>;
                        message: z.ZodString;
                        provenance: z.ZodObject<{
                            kind: z.ZodEnum<{
                                measured: "measured";
                                derived: "derived";
                                model: "model";
                            }>;
                            source: z.ZodString;
                            at: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>;
                    }, z.core.$strip>;
                    before: z.ZodNumber;
                    delta: z.ZodNumber;
                }, z.core.$strip>>;
                resolved: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    snapshotId: z.ZodNumber;
                    rule: z.ZodString;
                    tool: z.ZodString;
                    severity: z.ZodString;
                    node: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    destination: z.ZodOptional<z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>;
                    range: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                    metric: z.ZodOptional<z.ZodString>;
                    value: z.ZodOptional<z.ZodNumber>;
                    threshold: z.ZodOptional<z.ZodNumber>;
                    excess: z.ZodNullable<z.ZodNumber>;
                    status: z.ZodOptional<z.ZodEnum<{
                        new: "new";
                        carryover: "carryover";
                        resolved: "resolved";
                        worsened: "worsened";
                        improved: "improved";
                    }>>;
                    message: z.ZodString;
                    provenance: z.ZodObject<{
                        kind: z.ZodEnum<{
                            measured: "measured";
                            derived: "derived";
                            model: "model";
                        }>;
                        source: z.ZodString;
                        at: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            coupling: z.ZodObject<{
                measured: z.ZodBoolean;
                added: z.ZodArray<z.ZodObject<{
                    a: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    b: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    count: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            regressions: z.ZodArray<z.ZodObject<{
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                before: z.ZodNumber;
                after: z.ZodNumber;
                delta: z.ZodNumber;
                findings: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
            counts: z.ZodObject<{
                crossedCutoff: z.ZodNumber;
                newFiles: z.ZodNumber;
                newFindings: z.ZodNumber;
                worsened: z.ZodNumber;
                improved: z.ZodNumber;
                resolved: z.ZodNumber;
                newCoupling: z.ZodNumber;
                regressions: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly "paths.impact": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            baseline: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            paths: z.ZodArray<z.ZodString>;
            root: z.ZodOptional<z.ZodString>;
            window: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            rows: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                status: z.ZodLiteral<"indexed">;
                input: z.ZodString;
                path: z.ZodString;
                node: z.ZodObject<{
                    id: z.ZodString;
                    kind: z.ZodString;
                    name: z.ZodString;
                    path: z.ZodString;
                    span: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
                complexity: z.ZodNullable<z.ZodNumber>;
                hotspot: z.ZodObject<{
                    score: z.ZodNumber;
                    rank: z.ZodNullable<z.ZodNumber>;
                }, z.core.$strip>;
                findings: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    snapshotId: z.ZodNumber;
                    rule: z.ZodString;
                    tool: z.ZodString;
                    severity: z.ZodString;
                    node: z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>;
                    destination: z.ZodOptional<z.ZodObject<{
                        id: z.ZodString;
                        kind: z.ZodString;
                        name: z.ZodString;
                        path: z.ZodString;
                        span: z.ZodOptional<z.ZodObject<{
                            startLine: z.ZodNumber;
                            endLine: z.ZodNumber;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>;
                    range: z.ZodOptional<z.ZodObject<{
                        startLine: z.ZodNumber;
                        endLine: z.ZodNumber;
                    }, z.core.$strip>>;
                    metric: z.ZodOptional<z.ZodString>;
                    value: z.ZodOptional<z.ZodNumber>;
                    threshold: z.ZodOptional<z.ZodNumber>;
                    excess: z.ZodNullable<z.ZodNumber>;
                    status: z.ZodOptional<z.ZodEnum<{
                        new: "new";
                        carryover: "carryover";
                        resolved: "resolved";
                        worsened: "worsened";
                        improved: "improved";
                    }>>;
                    message: z.ZodString;
                    provenance: z.ZodObject<{
                        kind: z.ZodEnum<{
                            measured: "measured";
                            derived: "derived";
                            model: "model";
                        }>;
                        source: z.ZodString;
                        at: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>;
                }, z.core.$strip>>;
                delta: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    inBaseline: z.ZodBoolean;
                    scoreBefore: z.ZodNullable<z.ZodNumber>;
                    score: z.ZodNullable<z.ZodNumber>;
                    complexityBefore: z.ZodNullable<z.ZodNumber>;
                    complexity: z.ZodNullable<z.ZodNumber>;
                    findings: z.ZodObject<{
                        new: z.ZodNumber;
                        worsened: z.ZodNumber;
                        improved: z.ZodNumber;
                        resolved: z.ZodNumber;
                    }, z.core.$strip>;
                }, z.core.$strip>>>;
            }, z.core.$strip>, z.ZodObject<{
                status: z.ZodLiteral<"not-indexed">;
                input: z.ZodString;
                path: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                status: z.ZodLiteral<"outside-repo">;
                input: z.ZodString;
            }, z.core.$strip>], "status">>;
            ranked: z.ZodNumber;
            rollup: z.ZodObject<{
                indexed: z.ZodNumber;
                notIndexed: z.ZodNumber;
                outsideRepo: z.ZodNumber;
                score: z.ZodNumber;
                maxComplexity: z.ZodNullable<z.ZodNumber>;
                topRank: z.ZodNullable<z.ZodNumber>;
                openFindings: z.ZodNumber;
                delta: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    score: z.ZodNumber;
                    findings: z.ZodObject<{
                        new: z.ZodNumber;
                        worsened: z.ZodNumber;
                        improved: z.ZodNumber;
                        resolved: z.ZodNumber;
                    }, z.core.$strip>;
                }, z.core.$strip>>>;
            }, z.core.$strip>;
            baselineSnapshotId: z.ZodOptional<z.ZodNumber>;
            comparable: z.ZodOptional<z.ZodBoolean>;
            snapshotId: z.ZodNumber;
        }, z.core.$strip>;
    };
    readonly "packages.stats": {
        readonly description: string;
        readonly args: z.ZodObject<{
            snapshot: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            packages: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            snapshotId: z.ZodNumber;
            packagesFrom: z.ZodEnum<{
                none: "none";
                args: "args";
                tiers: "tiers";
            }>;
            modularity: z.ZodNumber;
            totalEdges: z.ZodNumber;
            unassignedFiles: z.ZodNumber;
            packages: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                fileCount: z.ZodNumber;
                internalEdges: z.ZodNumber;
                outgoingEdges: z.ZodNumber;
                incomingEdges: z.ZodNumber;
                cohesion: z.ZodNumber;
                instability: z.ZodNumber;
                abstractness: z.ZodNumber;
                band: z.ZodEnum<{
                    foundation: "foundation";
                    middle: "middle";
                    top: "top";
                }>;
                flags: z.ZodArray<z.ZodString>;
                layer: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    status: z.ZodLiteral<"declared">;
                    tier: z.ZodNumber;
                    rule: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    status: z.ZodLiteral<"undeclared">;
                }, z.core.$strip>], "status">;
            }, z.core.$strip>>;
            crossEdges: z.ZodArray<z.ZodObject<{
                from: z.ZodString;
                to: z.ZodString;
                edges: z.ZodNumber;
                intensity: z.ZodNumber;
                flag: z.ZodEnum<{
                    none: "none";
                    tight: "tight";
                    moderate: "moderate";
                }>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
};
type CommandName = keyof typeof CONTRACT;
type CommandArgs<N extends CommandName> = z.output<(typeof CONTRACT)[N]["args"]>;
type CommandInput<N extends CommandName> = z.input<(typeof CONTRACT)[N]["args"]>;
type CommandResult<N extends CommandName> = z.output<(typeof CONTRACT)[N]["result"]>;
/** Name to input args and result: the shape a typed client (`rpc-protocol`'s `CommandMap`) needs. */
type CodeReadCommandMap = {
    [N in CommandName]: {
        args: CommandInput<N>;
        result: CommandResult<N>;
    };
};
declare const COMMAND_NAMES: CommandName[];
/** The agent-shaped commands the design puts on MCP; `hierarchy.get` is UI-shaped. A product filters with this until the registry can (P3). */
declare const AGENT_COMMANDS: readonly CommandName[];
interface SerializedContract {
    api: string;
    commands: Record<string, {
        args: unknown;
        result: unknown;
    }>;
}
/** Args and results as JSON Schema in a stable key order; descriptions are docs, not contract, so they are left out. */
declare function serializeContract(): SerializedContract;

/** The row cap on `hierarchy.get`; past it the result says `truncated` and the shallowest rows are kept. */
declare const HIERARCHY_ROW_CAP = 5000;

/** A declared symbol of the file; code-graph's dossier keeps the top 8 exported and the top 8 internal. */
declare const ExportRow: z.ZodObject<{
    name: z.ZodString;
    utilization: z.ZodNumber;
    cognitive: z.ZodNullable<z.ZodNumber>;
    consumers: z.ZodNumber;
    exported: z.ZodBoolean;
}, z.core.$strip>;
/** The hotspot score at the node's grain, with the factors it multiplies; the factors are absent at a score of 0. */
declare const ScoreBreakdown: z.ZodObject<{
    grain: z.ZodEnum<{
        symbol: "symbol";
        file: "file";
    }>;
    window: z.ZodString;
    score: z.ZodNumber;
    churn: z.ZodOptional<z.ZodNumber>;
    complexity: z.ZodOptional<z.ZodNumber>;
    recency: z.ZodOptional<z.ZodNumber>;
    utilization: z.ZodOptional<z.ZodNumber>;
    rank: z.ZodNullable<z.ZodNumber>;
    ranked: z.ZodNumber;
}, z.core.$strip>;
/** PageRank over files and structural edges, as the reading order ranks them; null for generated code, which it leaves out. */
declare const Centrality: z.ZodObject<{
    score: z.ZodNullable<z.ZodNumber>;
    rank: z.ZodNullable<z.ZodNumber>;
    of: z.ZodNumber;
}, z.core.$strip>;
declare const CoupledPartners: z.ZodObject<{
    measured: z.ZodBoolean;
    partners: z.ZodArray<z.ZodObject<{
        node: z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        count: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const LinkedTests: z.ZodObject<{
    tests: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    indexedCount: z.ZodNullable<z.ZodNumber>;
    coEditMeasured: z.ZodBoolean;
}, z.core.$strip>;
declare const NodeLens: z.ZodEnum<{
    score: "score";
    exports: "exports";
    centrality: "centrality";
    coupling: "coupling";
    tests: "tests";
}>;
type NodeLens = z.infer<typeof NodeLens>;
/** Each requested lens; null when it does not describe the node's kind. Only `score` describes symbols; none describes directories. */
declare const NodeLenses: z.ZodObject<{
    exports: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        utilization: z.ZodNumber;
        cognitive: z.ZodNullable<z.ZodNumber>;
        consumers: z.ZodNumber;
        exported: z.ZodBoolean;
    }, z.core.$strip>>>>;
    score: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        grain: z.ZodEnum<{
            symbol: "symbol";
            file: "file";
        }>;
        window: z.ZodString;
        score: z.ZodNumber;
        churn: z.ZodOptional<z.ZodNumber>;
        complexity: z.ZodOptional<z.ZodNumber>;
        recency: z.ZodOptional<z.ZodNumber>;
        utilization: z.ZodOptional<z.ZodNumber>;
        rank: z.ZodNullable<z.ZodNumber>;
        ranked: z.ZodNumber;
    }, z.core.$strip>>>;
    centrality: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        score: z.ZodNullable<z.ZodNumber>;
        rank: z.ZodNullable<z.ZodNumber>;
        of: z.ZodNumber;
    }, z.core.$strip>>>;
    coupling: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        measured: z.ZodBoolean;
        partners: z.ZodArray<z.ZodObject<{
            node: z.ZodObject<{
                id: z.ZodString;
                kind: z.ZodString;
                name: z.ZodString;
                path: z.ZodString;
                span: z.ZodOptional<z.ZodObject<{
                    startLine: z.ZodNumber;
                    endLine: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            count: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    tests: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        tests: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        indexedCount: z.ZodNullable<z.ZodNumber>;
        coEditMeasured: z.ZodBoolean;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type NodeLenses = z.infer<typeof NodeLenses>;

/** Most rows one `findings.list` page returns; a table pages with `offset`. */
declare const FINDINGS_PAGE_MAX = 500;
/** Most lines one excerpt carries, whatever the flagged range and context ask for. */
declare const EXCERPT_LINE_CAP = 80;
declare const FindingSort: z.ZodEnum<{
    severity: "severity";
    value: "value";
    path: "path";
    excess: "excess";
    rule: "rule";
}>;
declare const Finding: z.ZodObject<{
    id: z.ZodString;
    snapshotId: z.ZodNumber;
    rule: z.ZodString;
    tool: z.ZodString;
    severity: z.ZodString;
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    destination: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    range: z.ZodOptional<z.ZodObject<{
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
    }, z.core.$strip>>;
    metric: z.ZodOptional<z.ZodString>;
    value: z.ZodOptional<z.ZodNumber>;
    threshold: z.ZodOptional<z.ZodNumber>;
    excess: z.ZodNullable<z.ZodNumber>;
    status: z.ZodOptional<z.ZodEnum<{
        new: "new";
        carryover: "carryover";
        resolved: "resolved";
        worsened: "worsened";
        improved: "improved";
    }>>;
    message: z.ZodString;
    provenance: z.ZodObject<{
        kind: z.ZodEnum<{
            measured: "measured";
            derived: "derived";
            model: "model";
        }>;
        source: z.ZodString;
        at: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
type Finding = z.infer<typeof Finding>;
declare const FindingStatus: z.ZodEnum<{
    new: "new";
    carryover: "carryover";
    resolved: "resolved";
    worsened: "worsened";
    improved: "improved";
}>;
type FindingStatus = z.infer<typeof FindingStatus>;
declare const SourceExcerpt: z.ZodObject<{
    path: z.ZodString;
    startLine: z.ZodNumber;
    endLine: z.ZodNumber;
    text: z.ZodString;
    contentHash: z.ZodString;
    origin: z.ZodEnum<{
        commit: "commit";
        worktree: "worktree";
        export: "export";
    }>;
    highlights: z.ZodArray<z.ZodObject<{
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
    }, z.core.$strip>>;
    truncated: z.ZodBoolean;
}, z.core.$strip>;
type SourceExcerpt = z.infer<typeof SourceExcerpt>;

/** Most rows one `hotspots.list` page returns; a table pages with `offset`. */
declare const HOTSPOTS_PAGE_MAX = 500;
/** A window as metric descriptors name it: "30d", or "lifetime" for all of git history. code-graph stores 30d, 90d, and 180d by default. */
declare const ChurnWindow: z.ZodString;
declare const Hotspot: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    churn: z.ZodNumber;
    complexity: z.ZodNumber;
    recency: z.ZodNumber;
    score: z.ZodNumber;
    utilization: z.ZodOptional<z.ZodNumber>;
    baselineScore: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    mark: z.ZodOptional<z.ZodEnum<{
        new: "new";
        worsened: "worsened";
    }>>;
}, z.core.$strip>;
type Hotspot = z.infer<typeof Hotspot>;
declare const HotspotMark: z.ZodEnum<{
    new: "new";
    worsened: "worsened";
}>;
type HotspotMark = z.infer<typeof HotspotMark>;

/** Most rows the reading order or the look-first list returns. */
declare const OVERVIEW_ROWS_MAX = 50;
/** One named signal of where attention is due, with the points the caller's weights give it. */
declare const AttentionSignal: z.ZodObject<{
    key: z.ZodEnum<{
        findings: "findings";
        complexity: "complexity";
        hotspots: "hotspots";
        "hidden-coupling": "hidden-coupling";
    }>;
    label: z.ZodString;
    penalty: z.ZodNumber;
    cap: z.ZodNumber;
    measured: z.ZodBoolean;
    detail: z.ZodString;
}, z.core.$strip>;
type AttentionSignal = z.infer<typeof AttentionSignal>;
declare const LookFirstRow: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    score: z.ZodNumber;
    churn: z.ZodNumber;
    complexity: z.ZodNumber;
    recency: z.ZodNumber;
    reasons: z.ZodArray<z.ZodEnum<{
        findings: "findings";
        "over-cutoff": "over-cutoff";
        "churn-complexity": "churn-complexity";
    }>>;
}, z.core.$strip>;
type LookFirstRow = z.infer<typeof LookFirstRow>;
declare const ReadingOrderRow: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    centrality: z.ZodNumber;
}, z.core.$strip>;
type ReadingOrderRow = z.infer<typeof ReadingOrderRow>;

/** Most paths one `paths.impact` call takes. */
declare const PATHS_IMPACT_MAX = 500;
declare const PathImpact: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"indexed">;
    input: z.ZodString;
    path: z.ZodString;
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    complexity: z.ZodNullable<z.ZodNumber>;
    hotspot: z.ZodObject<{
        score: z.ZodNumber;
        rank: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        snapshotId: z.ZodNumber;
        rule: z.ZodString;
        tool: z.ZodString;
        severity: z.ZodString;
        node: z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        destination: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        range: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
        metric: z.ZodOptional<z.ZodString>;
        value: z.ZodOptional<z.ZodNumber>;
        threshold: z.ZodOptional<z.ZodNumber>;
        excess: z.ZodNullable<z.ZodNumber>;
        status: z.ZodOptional<z.ZodEnum<{
            new: "new";
            carryover: "carryover";
            resolved: "resolved";
            worsened: "worsened";
            improved: "improved";
        }>>;
        message: z.ZodString;
        provenance: z.ZodObject<{
            kind: z.ZodEnum<{
                measured: "measured";
                derived: "derived";
                model: "model";
            }>;
            source: z.ZodString;
            at: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    delta: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        inBaseline: z.ZodBoolean;
        scoreBefore: z.ZodNullable<z.ZodNumber>;
        score: z.ZodNullable<z.ZodNumber>;
        complexityBefore: z.ZodNullable<z.ZodNumber>;
        complexity: z.ZodNullable<z.ZodNumber>;
        findings: z.ZodObject<{
            new: z.ZodNumber;
            worsened: z.ZodNumber;
            improved: z.ZodNumber;
            resolved: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"not-indexed">;
    input: z.ZodString;
    path: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"outside-repo">;
    input: z.ZodString;
}, z.core.$strip>], "status">;
type PathImpact = z.infer<typeof PathImpact>;
/** An indexed file against the baseline. Every `before` is null when the baseline does not hold the file. */
declare const PathDelta: z.ZodObject<{
    inBaseline: z.ZodBoolean;
    scoreBefore: z.ZodNullable<z.ZodNumber>;
    score: z.ZodNullable<z.ZodNumber>;
    complexityBefore: z.ZodNullable<z.ZodNumber>;
    complexity: z.ZodNullable<z.ZodNumber>;
    findings: z.ZodObject<{
        new: z.ZodNumber;
        worsened: z.ZodNumber;
        improved: z.ZodNumber;
        resolved: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
type PathDelta = z.infer<typeof PathDelta>;
declare const PathHotspot: z.ZodObject<{
    score: z.ZodNumber;
    rank: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type PathHotspot = z.infer<typeof PathHotspot>;
/** A file's findings against the baseline, bucketed as `changes.get` buckets them; counts only. */
declare const FindingDelta: z.ZodObject<{
    new: z.ZodNumber;
    worsened: z.ZodNumber;
    improved: z.ZodNumber;
    resolved: z.ZodNumber;
}, z.core.$strip>;
type FindingDelta = z.infer<typeof FindingDelta>;
declare const ImpactRollup: z.ZodObject<{
    indexed: z.ZodNumber;
    notIndexed: z.ZodNumber;
    outsideRepo: z.ZodNumber;
    score: z.ZodNumber;
    maxComplexity: z.ZodNullable<z.ZodNumber>;
    topRank: z.ZodNullable<z.ZodNumber>;
    openFindings: z.ZodNumber;
    delta: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        score: z.ZodNumber;
        findings: z.ZodObject<{
            new: z.ZodNumber;
            worsened: z.ZodNumber;
            improved: z.ZodNumber;
            resolved: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type ImpactRollup = z.infer<typeof ImpactRollup>;

/** Most package roots one `packages.stats` call takes. */
declare const PACKAGES_MAX = 500;
/** The package's tier in a `layered-deps` rule, 0 the lowest; a package no such rule names is `undeclared`. */
declare const PackageLayer: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"declared">;
    tier: z.ZodNumber;
    rule: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"undeclared">;
}, z.core.$strip>], "status">;
type PackageLayer = z.infer<typeof PackageLayer>;
declare const PackageStatsRow: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    fileCount: z.ZodNumber;
    internalEdges: z.ZodNumber;
    outgoingEdges: z.ZodNumber;
    incomingEdges: z.ZodNumber;
    cohesion: z.ZodNumber;
    instability: z.ZodNumber;
    abstractness: z.ZodNumber;
    band: z.ZodEnum<{
        foundation: "foundation";
        middle: "middle";
        top: "top";
    }>;
    flags: z.ZodArray<z.ZodString>;
    layer: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"declared">;
        tier: z.ZodNumber;
        rule: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        status: z.ZodLiteral<"undeclared">;
    }, z.core.$strip>], "status">;
}, z.core.$strip>;
type PackageStatsRow = z.infer<typeof PackageStatsRow>;
/** Edges from one package into another, with their share of the source package's files. */
declare const CrossEdge: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    edges: z.ZodNumber;
    intensity: z.ZodNumber;
    flag: z.ZodEnum<{
        none: "none";
        tight: "tight";
        moderate: "moderate";
    }>;
}, z.core.$strip>;
type CrossEdge = z.infer<typeof CrossEdge>;

/** Most rows each list of a `changes.get` result returns; `counts` always holds the full sizes. */
declare const CHANGES_ROWS_MAX = 500;
/** A file present at both snapshots whose hotspot score moved; a file with no score counts as 0. */
declare const ScoreChange: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    before: z.ZodNumber;
    after: z.ZodNumber;
    delta: z.ZodNumber;
}, z.core.$strip>;
type ScoreChange = z.infer<typeof ScoreChange>;
declare const NewFile: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    score: z.ZodNumber;
}, z.core.$strip>;
type NewFile = z.infer<typeof NewFile>;
/** A finding open at both snapshots whose measured value moved; `delta` is current value minus baseline value. */
declare const FindingChange: z.ZodObject<{
    finding: z.ZodObject<{
        id: z.ZodString;
        snapshotId: z.ZodNumber;
        rule: z.ZodString;
        tool: z.ZodString;
        severity: z.ZodString;
        node: z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        destination: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            name: z.ZodString;
            path: z.ZodString;
            span: z.ZodOptional<z.ZodObject<{
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        range: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
        metric: z.ZodOptional<z.ZodString>;
        value: z.ZodOptional<z.ZodNumber>;
        threshold: z.ZodOptional<z.ZodNumber>;
        excess: z.ZodNullable<z.ZodNumber>;
        status: z.ZodOptional<z.ZodEnum<{
            new: "new";
            carryover: "carryover";
            resolved: "resolved";
            worsened: "worsened";
            improved: "improved";
        }>>;
        message: z.ZodString;
        provenance: z.ZodObject<{
            kind: z.ZodEnum<{
                measured: "measured";
                derived: "derived";
                model: "model";
            }>;
            source: z.ZodString;
            at: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    before: z.ZodNumber;
    delta: z.ZodNumber;
}, z.core.$strip>;
type FindingChange = z.infer<typeof FindingChange>;
/** A file whose hotspot score rose since the baseline and that carries an open finding now. */
declare const Regression: z.ZodObject<{
    node: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    before: z.ZodNumber;
    after: z.ZodNumber;
    delta: z.ZodNumber;
    findings: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
type Regression = z.infer<typeof Regression>;
declare const CoChangePair: z.ZodObject<{
    a: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    b: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        span: z.ZodOptional<z.ZodObject<{
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    count: z.ZodNumber;
}, z.core.$strip>;
type CoChangePair = z.infer<typeof CoChangePair>;

/** Open string: "repo" | "package" | "directory" | "file" | "symbol" today; consumers tolerate unknown kinds. */
declare const NodeKind: z.ZodString;
/** Kinds code-read derives from file paths instead of reading from code-graph; such a node has no edges of its own. */
declare const SYNTHESIZED_KINDS: readonly ["repo", "directory"];
/** Whether code-graph stores nodes of this kind, so `node.neighbors` accepts them. */
declare function isStoredKind(kind: string): boolean;
/** Open string: "error" | "warning" | "info" today. */
declare const Severity: z.ZodString;
/** Why a value is null: the rollup rule forbids one, the node has no measurement, the metric does not describe the node, or the snapshot lacks the metric. */
declare const MISSING_REASONS: readonly ["no-rollup", "not-measured", "not-applicable", "not-in-snapshot"];
type Missing = (typeof MISSING_REASONS)[number];
/** An open string on the wire, so an older reader survives a new reason; `MISSING_REASONS` lists today's. */
declare const MissingReason: z.ZodString;
declare const ProvenanceKind: z.ZodEnum<{
    measured: "measured";
    derived: "derived";
    model: "model";
}>;
type ProvenanceKind = z.infer<typeof ProvenanceKind>;
declare const Provenance: z.ZodObject<{
    kind: z.ZodEnum<{
        measured: "measured";
        derived: "derived";
        model: "model";
    }>;
    source: z.ZodString;
    at: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Provenance = z.infer<typeof Provenance>;
declare const SnapshotInfo: z.ZodObject<{
    id: z.ZodNumber;
    ref: z.ZodString;
    commit: z.ZodNullable<z.ZodString>;
    takenAt: z.ZodString;
    indexVersion: z.ZodString;
}, z.core.$strip>;
type SnapshotInfo = z.infer<typeof SnapshotInfo>;
declare const MetricDescriptor: z.ZodObject<{
    name: z.ZodString;
    unit: z.ZodNullable<z.ZodString>;
    appliesTo: z.ZodArray<z.ZodString>;
    rollup: z.ZodEnum<{
        sum: "sum";
        max: "max";
        mean: "mean";
        none: "none";
    }>;
    direction: z.ZodEnum<{
        "higher-worse": "higher-worse";
        "lower-worse": "lower-worse";
        neutral: "neutral";
    }>;
    absent: z.ZodEnum<{
        zero: "zero";
        exclude: "exclude";
    }>;
    window: z.ZodOptional<z.ZodString>;
    description: z.ZodString;
    provenance: z.ZodObject<{
        kind: z.ZodEnum<{
            measured: "measured";
            derived: "derived";
            model: "model";
        }>;
        source: z.ZodString;
        at: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
type MetricDescriptor = z.infer<typeof MetricDescriptor>;
declare const RuleSummary: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodString;
    severity: z.ZodString;
}, z.core.$strip>;
type RuleSummary = z.infer<typeof RuleSummary>;
declare const Capabilities: z.ZodObject<{
    findings: z.ZodEnum<{
        none: "none";
        "check-rules": "check-rules";
        store: "store";
    }>;
    verdicts: z.ZodBoolean;
    themes: z.ZodBoolean;
    feedback: z.ZodBoolean;
    embeddings: z.ZodNullable<z.ZodObject<{
        model: z.ZodString;
        embedded: z.ZodNumber;
        symbols: z.ZodNumber;
    }, z.core.$strip>>;
    cochange: z.ZodBoolean;
    sourceAtCommit: z.ZodBoolean;
    excerpts: z.ZodEnum<{
        any: "any";
        none: "none";
        flagged: "flagged";
    }>;
}, z.core.$strip>;
type Capabilities = z.infer<typeof Capabilities>;
/** A snapshot id, a digit string, or a ref name meaning that ref's newest snapshot. Omitted means the newest overall. */
declare const SnapshotRef: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
type SnapshotRef = z.infer<typeof SnapshotRef>;
declare const Span: z.ZodObject<{
    startLine: z.ZodNumber;
    endLine: z.ZodNumber;
}, z.core.$strip>;
type Span = z.infer<typeof Span>;
/** How a node is addressed everywhere in the API; consumers treat `id` as opaque and read the other fields. */
declare const NodeRef: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodString;
    name: z.ZodString;
    path: z.ZodString;
    span: z.ZodOptional<z.ZodObject<{
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type NodeRef = z.infer<typeof NodeRef>;

/** A graph node as the read API holds it; mirrors code-graph's `GraphNode` without importing it. */
interface ModelNode {
    id: string;
    kind: string;
    name: string;
    parentId: string | null;
    language?: string;
    role?: string;
    attrs: Record<string, unknown>;
}
interface ModelEdge {
    srcId: string;
    dstId: string;
    kind: string;
    attrs: Record<string, unknown>;
}
interface ModelAlias {
    oldId: string;
    newId: string;
    reason: string;
}
interface ModelMetric {
    nodeId: string;
    name: string;
    value: number | null;
    unit?: string;
}
/** A rule as findings cite it: `text` is a plain-language statement of what the rule demands. */
interface ModelRule {
    id: string;
    type: string;
    severity: string;
    text: string;
    /** A `layered-deps` rule's tiers of package roots, lowest first; the repo's tier config. */
    layers?: readonly (readonly string[])[];
}
/** One check-rule violation, keyed by the ratchet's `violationKey`; `ranges` are the flagged lines, absent for a whole-node finding. */
interface ModelFinding {
    id: string;
    rule: string;
    severity: string;
    nodeId: string;
    destinationId?: string;
    metric?: string;
    value?: number;
    threshold?: number;
    message: string;
    ranges?: readonly Span[];
}
/** A catalogue entry as code-graph's `describeMetric` returns it; provenance is added here. */
interface CatalogueEntry {
    name: string;
    unit: string;
    appliesTo: readonly string[];
    rollup: MetricDescriptor["rollup"];
    direction: MetricDescriptor["direction"];
    absent: MetricDescriptor["absent"];
    source: string;
    description: string;
    window?: string;
}
/** Everything one snapshot holds, indexed for reads. Snapshots are immutable, so a model never goes stale. */
interface ReadModel {
    snapshot: SnapshotInfo;
    nodes: readonly ModelNode[];
    nodeById: ReadonlyMap<string, ModelNode>;
    edges: readonly ModelEdge[];
    aliases: readonly ModelAlias[];
    /** Metric name to node id to value. */
    metrics: ReadonlyMap<string, ReadonlyMap<string, number | null>>;
    /** One descriptor per metric name present in the snapshot, sorted by name. */
    metricCatalogue: readonly MetricDescriptor[];
    /** Derived on load from the product's rules; a changed rule set means a different model. */
    findings: readonly ModelFinding[];
    rules: readonly ModelRule[];
}
interface ReadModelParts {
    snapshot: SnapshotInfo;
    nodes: readonly ModelNode[];
    edges: readonly ModelEdge[];
    aliases: readonly ModelAlias[];
    metrics: readonly ModelMetric[];
    /** The catalogue lookup, injected so this module never imports code-graph's Node-only root. */
    describe: (name: string) => CatalogueEntry | null;
    findings?: readonly ModelFinding[];
    rules?: readonly ModelRule[];
}
declare function buildReadModel(parts: ReadModelParts): ReadModel;

/** What a source can serve, independent of any one snapshot. */
interface SourceFacts {
    dataset: "live" | "static";
    commands: readonly CommandName[];
    capabilities: Capabilities;
    rules: readonly RuleSummary[];
}
/** Where excerpt text came from: the snapshot's commit, a working tree proven to match it, or a static export. */
type SourceOrigin = "commit" | "worktree" | "export";
/** Some or all of one file's lines as they were at the snapshot; `startLine` is the first line held. */
interface SourceWindow {
    path: string;
    contentHash: string;
    origin: SourceOrigin;
    startLine: number;
    lines: readonly string[];
    /** Lines in the whole file, so a window can be clipped at the file's end. */
    lineCount: number;
}
/** Why a finding has no excerpt; the wire carries an open string, so an older reader survives a new reason. */
declare const EXCERPT_MISSING: readonly ["no-source", "not-a-source-file", "unreadable", "changed-since-snapshot", "not-in-export"];
type ExcerptMissing = (typeof EXCERPT_MISSING)[number];
type SourceRead = SourceWindow | {
    unavailable: ExcerptMissing;
};
/**
 * The seam every query function reads through. The daemon implements it over SQLite with an
 * LRU of models; a static export implements it over a decoded dataset. Same queries, same answers.
 */
interface ReadSource {
    facts(): SourceFacts;
    /** Every snapshot, newest first. */
    snapshots(): readonly SnapshotInfo[];
    /** Throws a `ReadError` with `EXIT.NOINPUT` when the snapshot does not exist. */
    model(snapshotId: number): ReadModel;
    /** A file's text at the snapshot; absent when the source holds no source text at all. */
    readSource?(snapshotId: number, path: string): SourceRead;
    /** The directory the snapshots were indexed from; absent or null when the source does not know it (a static export). */
    repoRoot?: string | null;
}
/** A failure carrying the sysexits code every surface reports, so the registry's `describeError` maps it as is. */
declare class ReadError extends Error {
    readonly code: number;
    constructor(message: string, code: number);
}
declare function snapshotNotFound(snapshotId: number): ReadError;
declare function nodeNotFound(id: string, snapshotId: number): ReadError;
declare function findingNotFound(id: string, snapshotId: number): ReadError;
/** Bad arguments the schema cannot express, such as "exactly one of"; same code as a schema failure. */
declare function invalidArgs(message: string): ReadError;

/** An id, a digit string, or a ref name (its newest snapshot); omitted means the newest overall. */
declare function resolveSnapshot(source: ReadSource, ref: SnapshotRef | undefined): SnapshotInfo;

interface MetricValue {
    value: number | null;
    missing?: Missing;
}

type QueryFn<N extends CommandName> = (source: ReadSource, args: CommandArgs<N>) => CommandResult<N>;
declare function describeApi(source: ReadSource): CommandResult<"api.describe">;
declare function listSnapshots(source: ReadSource, args: CommandArgs<"snapshot.list">): CommandResult<"snapshot.list">;
/** One pure function per command; the registry commands and the static resolver both dispatch here. */
declare const QUERIES: {
    [N in CommandName]: QueryFn<N>;
};

type HierarchyResult = CommandResult<"hierarchy.get">;
/** `hierarchy.get`: a flat, shallowest-first slice of the synthesized tree with per-row metric values. */
declare function getHierarchy(source: ReadSource, args: CommandArgs<"hierarchy.get">): HierarchyResult;

type NodeGetResult = CommandResult<"node.get">;
/** `node.get`: one node of the synthesized hierarchy with its numbers in context. */
declare function getNode(source: ReadSource, args: CommandArgs<"node.get">): NodeGetResult;

/** `node.resolve`: a path, path:line, symbol name, or qualified id to ranked candidate nodes. */
declare function resolveNode(source: ReadSource, args: CommandArgs<"node.resolve">): CommandResult<"node.resolve">;

type ListArgs$1 = CommandArgs<"findings.list">;
type ListResult$1 = CommandResult<"findings.list">;
/** `findings.list`: a snapshot's findings, filtered, ordered by a total order, and cut to one page. */
declare function listFindings(source: ReadSource, args: ListArgs$1): ListResult$1;

type ListArgs = CommandArgs<"hotspots.list">;
type ListResult = CommandResult<"hotspots.list">;
/** `hotspots.list`: a snapshot's hotspots at one grain, cut at `cutoff`, optionally marked against a baseline, and paged. */
declare function listHotspots(source: ReadSource, args: ListArgs): ListResult;

type OverviewArgs = CommandArgs<"overview.get">;
type OverviewResult = CommandResult<"overview.get">;
/** `overview.get`: KPIs, weighted attention signals, the reading order, and where to look first, for one snapshot. */
declare function getOverview(source: ReadSource, args: OverviewArgs): OverviewResult;

type ChangesArgs = CommandArgs<"changes.get">;
type ChangesResult = CommandResult<"changes.get">;
/** `changes.get`: what moved between a baseline snapshot and this one, or `comparable: false` across index versions. */
declare function getChanges(source: ReadSource, args: ChangesArgs): ChangesResult;

type ImpactArgs = CommandArgs<"paths.impact">;
type ImpactResult = CommandResult<"paths.impact">;
/** Repo-relative form of a path, or null when it lies outside the repo. Absolute paths count only under `root`. */
declare function repoRelative(input: string, root: string | undefined): string | null;
/** `paths.impact`: complexity, hotspot rank, and open findings for each given file, optionally against a baseline. */
declare function pathsImpact(source: ReadSource, args: ImpactArgs): ImpactResult;

type StatsArgs = CommandArgs<"packages.stats">;
type StatsResult = CommandResult<"packages.stats">;
type Declared = Extract<PackageLayer, {
    status: "declared";
}>;
/** Package root to its tier; a root two rules name keeps the first rule's tier. */
declare function declaredTiers(rules: readonly ModelRule[]): Map<string, Declared>;
/** `packages.stats`: code-graph's partition quality over the package roots, each with its declared tier. */
declare function packagesStats(source: ReadSource, args: StatsArgs): StatsResult;

type GetResult = CommandResult<"finding.get">;
/** Findings shown beside the one asked for: the same node's, then the same rule's on graph neighbours. */
declare const RELATED_CAP = 10;
/** `finding.get`: one finding with its rule, numbers in context, the flagged source, and related findings. */
declare function getFinding(source: ReadSource, args: CommandArgs<"finding.get">): GetResult;

type NeighborsResult = CommandResult<"node.neighbors">;
/** `node.neighbors`: a stored node's inbound and outbound edges, each side paged on its own. */
declare function getNeighbors(source: ReadSource, args: CommandArgs<"node.neighbors">): NeighborsResult;

/** Larger is worse for every rule: value over threshold for a maximum, threshold over value for a minimum. */
declare const excessOf: typeof violationExcess;

/** rpc-client's static `resolve` option: raw args in, an envelope out, never a throw. */
type QueryResolver = (name: string, args: unknown) => JsonEnvelope<unknown>;
/** Validate, run, and envelope one command against a source, exactly as the daemon's registry does. */
declare function createQueryResolver(source: ReadSource): QueryResolver;

export { AGENT_COMMANDS, AttentionSignal, CHANGES_ROWS_MAX, CODE_READ_API_VERSION, COMMAND_NAMES, CONTRACT, Capabilities, type CatalogueEntry, Centrality, ChurnWindow, CoChangePair, type CodeReadCommandMap, type CommandArgs, type CommandContract, type CommandInput, type CommandName, type CommandResult, CoupledPartners, CrossEdge, EXCERPT_LINE_CAP, EXCERPT_MISSING, type ExcerptMissing, ExportRow, FINDINGS_PAGE_MAX, Finding, FindingChange, FindingDelta, FindingSort, FindingStatus, HIERARCHY_ROW_CAP, HOTSPOTS_PAGE_MAX, Hotspot, HotspotMark, ImpactRollup, LinkedTests, LookFirstRow, MISSING_REASONS, MetricDescriptor, type MetricValue, type Missing, MissingReason, type ModelAlias, type ModelEdge, type ModelFinding, type ModelMetric, type ModelNode, type ModelRule, NewFile, NodeKind, NodeLens, NodeLenses, NodeRef, OVERVIEW_ROWS_MAX, PACKAGES_MAX, PATHS_IMPACT_MAX, PackageLayer, PackageStatsRow, PathDelta, PathHotspot, PathImpact, Provenance, ProvenanceKind, QUERIES, type QueryFn, type QueryResolver, RELATED_CAP, ReadError, type ReadModel, type ReadModelParts, type ReadSource, ReadingOrderRow, Regression, RuleSummary, SYNTHESIZED_KINDS, ScoreBreakdown, ScoreChange, type SerializedContract, Severity, SnapshotInfo, SnapshotRef, SourceExcerpt, type SourceFacts, type SourceOrigin, type SourceRead, type SourceWindow, Span, buildReadModel, createQueryResolver, declaredTiers, describeApi, excessOf, findingNotFound, getChanges, getFinding, getHierarchy, getNeighbors, getNode, getOverview, invalidArgs, isStoredKind, listFindings, listHotspots, listSnapshots, nodeNotFound, packagesStats, pathsImpact, repoRelative, resolveNode, resolveSnapshot, serializeContract, snapshotNotFound };
