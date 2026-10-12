import * as zod from 'zod';
import { z } from 'zod';

declare const ExampleSchema: z.ZodObject<{
    good: z.ZodOptional<z.ZodString>;
    bad: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const StabilitySchema: z.ZodEnum<{
    high: "high";
    medium: "medium";
    low: "low";
}>;
declare const FixabilitySchema: z.ZodEnum<{
    safe: "safe";
    "maybe-incorrect": "maybe-incorrect";
    "requires-input": "requires-input";
    "not-fixable": "not-fixable";
}>;
declare const StyleRuleSchema: z.ZodObject<{
    convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
    confidence: z.ZodNumber;
    stability: z.ZodOptional<z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
    }>>;
    fixability: z.ZodOptional<z.ZodEnum<{
        safe: "safe";
        "maybe-incorrect": "maybe-incorrect";
        "requires-input": "requires-input";
        "not-fixable": "not-fixable";
    }>>;
    description: z.ZodOptional<z.ZodString>;
    examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
        good: z.ZodOptional<z.ZodString>;
        bad: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
type StyleRule = z.infer<typeof StyleRuleSchema>;
type Stability = z.infer<typeof StabilitySchema>;
type Fixability = z.infer<typeof FixabilitySchema>;

declare const SCHEMA_VERSION = "1.0.0";
declare const SeverityThresholdsSchema: z.ZodObject<{
    error: z.ZodNumber;
    warn: z.ZodNumber;
    info: z.ZodNumber;
}, z.core.$strip>;
declare const DEFAULT_SEVERITY_THRESHOLDS: {
    readonly error: 0.85;
    readonly warn: 0.6;
    readonly info: 0.4;
};
declare const ProfileSchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    schemaVersion: z.ZodString;
    author: z.ZodString;
    generated: z.ZodString;
    sources: z.ZodArray<z.ZodString>;
    naming: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    structure: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    documentation: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    errorHandling: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    formatting: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    patterns: z.ZodRecord<z.ZodString, z.ZodObject<{
        convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
        confidence: z.ZodNumber;
        stability: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
        fixability: z.ZodOptional<z.ZodEnum<{
            safe: "safe";
            "maybe-incorrect": "maybe-incorrect";
            "requires-input": "requires-input";
            "not-fixable": "not-fixable";
        }>>;
        description: z.ZodOptional<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
            good: z.ZodOptional<z.ZodString>;
            bad: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    idioms: z.ZodObject<{
        detected: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            frequency: z.ZodNumber;
            confidence: z.ZodNumber;
            example: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    antiPatterns: z.ZodObject<{
        acknowledged: z.ZodArray<z.ZodObject<{
            pattern: z.ZodString;
            reason: z.ZodString;
            deprecated: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    overrides: z.ZodArray<z.ZodObject<{
        files: z.ZodArray<z.ZodString>;
        naming: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
        structure: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
        documentation: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
        errorHandling: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
        formatting: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
        patterns: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            convention: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>;
            confidence: z.ZodNumber;
            stability: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            fixability: z.ZodOptional<z.ZodEnum<{
                safe: "safe";
                "maybe-incorrect": "maybe-incorrect";
                "requires-input": "requires-input";
                "not-fixable": "not-fixable";
            }>>;
            description: z.ZodOptional<z.ZodString>;
            examples: z.ZodOptional<z.ZodArray<z.ZodObject<{
                good: z.ZodOptional<z.ZodString>;
                bad: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    severityThresholds: z.ZodDefault<z.ZodObject<{
        error: z.ZodNumber;
        warn: z.ZodNumber;
        info: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Profile = z.infer<typeof ProfileSchema>;
type SeverityThresholds = z.infer<typeof SeverityThresholdsSchema>;
declare const PROFILE_CATEGORIES: readonly ["naming", "structure", "documentation", "errorHandling", "formatting", "patterns"];
type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];
type Severity = "error" | "warn" | "info" | "off";

type EslintSeverity = "error" | "warn" | "off";
/** The one confidence ladder: a rule's profile tier, "off" below the info threshold. */
declare function severityForConfidence(confidence: number, thresholds?: SeverityThresholds): Severity;
declare function toEslintLevel(severity: Severity): EslintSeverity;

declare function readProfile(filePath: string): Promise<Profile>;
declare function writeProfile(filePath: string, profile: unknown): Promise<void>;
declare function validateProfile(data: unknown): zod.ZodSafeParseResult<{
    schemaVersion: string;
    author: string;
    generated: string;
    sources: string[];
    naming: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    structure: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    documentation: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    errorHandling: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    formatting: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    patterns: Record<string, {
        convention: string | number | boolean | string[];
        confidence: number;
        stability?: "high" | "medium" | "low" | undefined;
        fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
        description?: string | undefined;
        examples?: {
            good?: string | undefined;
            bad?: string | undefined;
            source?: string | undefined;
        }[] | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    idioms: {
        detected: {
            name: string;
            description: string;
            frequency: number;
            confidence: number;
            example?: string | undefined;
        }[];
    };
    antiPatterns: {
        acknowledged: {
            pattern: string;
            reason: string;
            deprecated?: boolean | undefined;
        }[];
    };
    overrides: {
        files: string[];
        naming?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
        structure?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
        documentation?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
        errorHandling?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
        formatting?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
        patterns?: Record<string, {
            convention: string | number | boolean | string[];
            confidence: number;
            stability?: "high" | "medium" | "low" | undefined;
            fixability?: "safe" | "maybe-incorrect" | "requires-input" | "not-fixable" | undefined;
            description?: string | undefined;
            examples?: {
                good?: string | undefined;
                bad?: string | undefined;
                source?: string | undefined;
            }[] | undefined;
            extensions?: Record<string, unknown> | undefined;
        }> | undefined;
    }[];
    severityThresholds: {
        error: number;
        warn: number;
        info: number;
    };
    $schema?: string | undefined;
}>;

interface Migration {
    from: string;
    to: string;
    migrate: (profile: Record<string, unknown>) => Record<string, unknown>;
}
declare function registerMigration(migration: Migration): void;

declare function migrateProfile(profile: Record<string, unknown>): Record<string, unknown>;

interface GeneratedFile {
    path: string;
    content: string;
}

declare function generateSkillFiles(profile: Profile): GeneratedFile[];

declare function generateClaudeRules(profile: Profile): GeneratedFile[];

interface ClaudeCommandHook {
    type: "command";
    command: string;
}
interface ClaudeHookMatcher {
    matcher: string;
    hooks: ClaudeCommandHook[];
}
interface ClaudeSettingsHooks {
    hooks: {
        PostToolUse: ClaudeHookMatcher[];
    };
}
declare function generateHooksConfig(_profile: Profile): ClaudeSettingsHooks;

declare function generateEslintExport(profile: Profile): GeneratedFile;

type EmittedEslintSeverity = "error" | "warn";
declare function toEslintSeverity(confidence: number, thresholds: SeverityThresholds): EmittedEslintSeverity | null;
declare function severityRank(s: Severity): number;
/** Same shape as style-checker's SkippedRule, so a consumer can forward it unchanged. */
interface EslintSkippedRule {
    tool: "eslint";
    rule: string;
    plugin: string;
    reason: string;
}
interface NamingConventionResult {
    rule: [string, unknown] | null;
    skippedRules: EslintSkippedRule[];
}
declare function toTsEslintFormat(convention: string): string | null;
declare function buildNamingConvention(profile: Profile): NamingConventionResult;
declare function buildNamingConventionRule(profile: Profile): [string, unknown] | null;
declare function buildImportOrderRule(profile: Profile): [string, unknown] | null;
declare function buildFunctionLengthRule(profile: Profile): [string, unknown] | null;
declare function buildFileNamingRule(profile: Profile): [string, unknown] | null;
declare function buildJsdocRules(profile: Profile): Array<[string, unknown]>;

declare function generateRuffExport(profile: Profile): GeneratedFile;

declare function generateMarkdownExport(profile: Profile): GeneratedFile;

declare function generateEditorConfigExport(profile: Profile): GeneratedFile;

type ExportFormat = "skill" | "claude-rules" | "hooks" | "eslint" | "ruff" | "markdown" | "editorconfig";
declare const SUPPORTED_FORMATS: ExportFormat[];
declare function exportProfile(profile: Profile, format: ExportFormat): GeneratedFile[];

interface RuleEntry {
    category: string;
    name: string;
    convention: unknown;
    confidence: number;
    stability?: string;
    description?: string;
    examples?: Array<{
        good?: string;
        bad?: string;
        source?: string;
    }>;
    extensions?: Record<string, unknown>;
}
type ExtractedRule = RuleEntry;
declare function extractAllRules(profile: Profile): RuleEntry[];
declare function getTopRules(profile: Profile, count?: number): RuleEntry[];
declare function getRulesForCategory(profile: Profile, category: string): RuleEntry[];
declare function getRulesByCategory(profile: Profile): Map<string, RuleEntry[]>;
declare function detectLanguages(profile: Profile): string[];

export { DEFAULT_SEVERITY_THRESHOLDS, type EslintSeverity, type EslintSkippedRule, ExampleSchema, type ExportFormat, type ExtractedRule, type Fixability, FixabilitySchema, type GeneratedFile, type NamingConventionResult, PROFILE_CATEGORIES, type Profile, type ProfileCategory, ProfileSchema, type RuleEntry, SCHEMA_VERSION, SUPPORTED_FORMATS, type Severity, type SeverityThresholds, type Stability, StabilitySchema, type StyleRule, StyleRuleSchema, buildFileNamingRule, buildFunctionLengthRule, buildImportOrderRule, buildJsdocRules, buildNamingConvention, buildNamingConventionRule, detectLanguages, exportProfile, extractAllRules, generateClaudeRules, generateEditorConfigExport, generateEslintExport, generateHooksConfig, generateMarkdownExport, generateRuffExport, generateSkillFiles, getRulesByCategory, getRulesForCategory, getTopRules, migrateProfile, readProfile, registerMigration, severityForConfidence, severityRank, toEslintLevel, toEslintSeverity, toTsEslintFormat, validateProfile, writeProfile };
