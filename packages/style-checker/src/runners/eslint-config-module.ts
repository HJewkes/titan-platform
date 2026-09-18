import {
  PARSER_SOURCES,
  PLUGIN_SOURCES,
  describeSources,
  pluginNamespace,
  resolveModule,
} from "./eslint-plugins.js";
import type { ResolvedModule } from "./eslint-plugins.js";
import type { EslintFlatConfigEntry } from "../generators/eslint.js";
import type { SkippedRule, ToolFailure } from "../orchestrator/types.js";

export type EslintConfigModule =
  | { ok: true; source: string; ruleCount: number; skippedRules: SkippedRule[] }
  | { ok: false; failure: ToolFailure };

interface ModuleContext {
  fromDir: string;
  imports: string[];
  ids: Map<string, string>;
  plugins: Map<string, ResolvedModule | null>;
}

function importExpr(ctx: ModuleContext, mod: ResolvedModule): string {
  let id = ctx.ids.get(mod.url);
  if (!id) {
    id = `m${ctx.ids.size}`;
    ctx.ids.set(mod.url, id);
    ctx.imports.push(`import ${id} from ${JSON.stringify(mod.url)};`);
  }
  return mod.member ? `${id}.${mod.member}` : id;
}

function resolvePlugin(ctx: ModuleContext, namespace: string): ResolvedModule | null {
  if (!ctx.plugins.has(namespace)) {
    const sources = PLUGIN_SOURCES[namespace];
    ctx.plugins.set(namespace, sources ? resolveModule(sources, ctx.fromDir) : null);
  }
  return ctx.plugins.get(namespace) ?? null;
}

function skipReason(ctx: ModuleContext, namespace: string): string {
  const sources = PLUGIN_SOURCES[namespace];
  if (!sources) return `no known package provides the ESLint plugin "${namespace}"`;
  return `${describeSources(sources)} is not installed in ${ctx.fromDir}`;
}

function renderEntry(
  ctx: ModuleContext,
  entry: EslintFlatConfigEntry,
  parserExpr: string,
  skipped: SkippedRule[],
): { text: string; ruleCount: number } {
  const rules: Record<string, unknown> = {};
  const plugins: string[] = [];
  for (const [rule, value] of Object.entries(entry.rules ?? {})) {
    const namespace = pluginNamespace(rule);
    const plugin = namespace === null ? null : resolvePlugin(ctx, namespace);
    if (namespace !== null && !plugin) {
      skipped.push({ tool: "eslint", rule, plugin: namespace, reason: skipReason(ctx, namespace) });
      continue;
    }
    rules[rule] = value;
    if (namespace !== null && plugin) plugins.push(`${JSON.stringify(namespace)}: ${importExpr(ctx, plugin)}`);
  }
  const data = JSON.stringify({ files: entry.files, rules });
  const text = `{ ...${data}, languageOptions: { parser: ${parserExpr} }, plugins: { ${[...new Set(plugins)].join(", ")} } }`;
  return { text, ruleCount: Object.keys(rules).length };
}

export function buildEslintConfigModule(
  config: EslintFlatConfigEntry[],
  fromDir: string,
): EslintConfigModule {
  const parser = resolveModule(PARSER_SOURCES, fromDir);
  if (!parser) {
    const message = `${describeSources(PARSER_SOURCES)} is not installed in ${fromDir}, so ESLint cannot parse TypeScript`;
    return { ok: false, failure: { tool: "eslint", kind: "missing-dependency", message } };
  }
  const ctx: ModuleContext = { fromDir, imports: [], ids: new Map(), plugins: new Map() };
  const parserExpr = importExpr(ctx, parser);
  const skippedRules: SkippedRule[] = [];
  const entries = config.map((entry) => renderEntry(ctx, entry, parserExpr, skippedRules));
  const ruleCount = entries.reduce((sum, e) => sum + e.ruleCount, 0);
  const body = entries.map((e) => e.text).join(",\n  ");
  const source = `${ctx.imports.join("\n")}\n\nexport default [\n  ${body},\n];\n`;
  return { ok: true, source, ruleCount, skippedRules };
}
