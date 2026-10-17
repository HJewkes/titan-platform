import { z } from 'zod';

type ShapeId = "gh-pr-merge" | "rest-pr-merge" | "rest-branch-merge" | "graphql-merge" | "octokit-merge";
interface Shape {
    id: ShapeId;
    /** Global, so `matchAll` finds every hit; `\s+` between words lets a match cross a soft-wrapped line. */
    pattern: RegExp;
    /** True when the text right after a match cancels it. */
    cancelledBy?: RegExp;
}
/** Case-insensitive like tool-guard, which folds case before it classifies. */
declare const SHAPES: readonly Shape[];
interface ShapeHit {
    shape: ShapeId;
    /** Character offset where the match starts. */
    index: number;
}
declare function findHits(text: string): ShapeHit[];

declare const RulesSchema: z.ZodObject<{
    $schema: z.ZodLiteral<"merge-lint/1">;
    level: z.ZodEnum<{
        error: "error";
        warn: "warn";
    }>;
    scan: z.ZodObject<{
        include: z.ZodArray<z.ZodString>;
        brief: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    exclude: z.ZodArray<z.ZodString>;
    allow: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"wrapper">;
        mergePath: z.ZodString;
        logs: z.ZodBoolean;
        path: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"detector">;
        path: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"deny-list">;
        path: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>], "kind">>;
}, z.core.$strict>;
type Rules = z.infer<typeof RulesSchema>;
type RulesResult = {
    ok: true;
    rules: Rules;
} | {
    ok: false;
    error: string;
};
declare function parseRules(source: string): RulesResult;

interface SourceFile {
    path: string;
    text: string;
}
interface Finding {
    path: string;
    line: number;
    shape: ShapeId;
    /** The hit's line, trimmed. */
    text: string;
    /** Index into `rules.allow` of the entry that covers the hit, or null when nothing does. */
    allowedBy: number | null;
}
interface ScanResult {
    findings: Finding[];
    /** Allow entries that cover no hit. */
    stale: number[];
    /** Wrapper entries still at `logs: false`. */
    notLogging: number[];
}
/** `**` crosses directories, `*` does not, `?` is one non-separator character. */
declare function globToRegExp(glob: string): RegExp;
/** A brief glob keeps a file in scope even when an exclude would drop it. */
declare function inScope(rules: Rules, file: string): boolean;
/** Pure: no I/O. `scoped` files only; callers that scan a piped brief pass `scoped: false`. */
declare function scan(files: readonly SourceFile[], rules: Rules, options?: {
    scoped?: boolean;
}): ScanResult;

declare const RULES_PATH = ".github/merge-lint.json";
interface Report {
    lines: string[];
    /** Hits no allow entry covers. */
    unallowed: number;
}
/** One line per finding: `path:line` first, so a CI log links to the file. */
declare function formatFinding(finding: Finding, actions: boolean): string;
declare function buildReport(result: ScanResult, rules: Rules, actions: boolean): Report;
declare function summaryLine(result: ScanResult, report: Report, level: Rules["level"]): string;

export { type Finding, RULES_PATH, type Report, type Rules, type RulesResult, RulesSchema, SHAPES, type ScanResult, type Shape, type ShapeHit, type ShapeId, type SourceFile, buildReport, findHits, formatFinding, globToRegExp, inScope, parseRules, scan, summaryLine };
