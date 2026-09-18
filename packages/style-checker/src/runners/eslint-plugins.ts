import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ModuleSource {
  specifier: string;
  member?: "plugin" | "parser";
}

export interface ResolvedModule {
  url: string;
  member?: "plugin" | "parser";
}

// The typescript-eslint meta-package is the fallback because under pnpm it is often the only one a project can resolve.
export const PLUGIN_SOURCES: Record<string, ModuleSource[]> = {
  "@typescript-eslint": [
    { specifier: "@typescript-eslint/eslint-plugin" },
    { specifier: "typescript-eslint", member: "plugin" },
  ],
  perfectionist: [{ specifier: "eslint-plugin-perfectionist" }],
  unicorn: [{ specifier: "eslint-plugin-unicorn" }],
  jsdoc: [{ specifier: "eslint-plugin-jsdoc" }],
};

export const PARSER_SOURCES: ModuleSource[] = [
  { specifier: "@typescript-eslint/parser" },
  { specifier: "typescript-eslint", member: "parser" },
];

export function pluginNamespace(rule: string): string | null {
  const slash = rule.lastIndexOf("/");
  return slash === -1 ? null : rule.slice(0, slash);
}

export function describeSources(sources: ModuleSource[]): string {
  return sources.map((s) => s.specifier).join(" or ");
}

export function resolveModule(
  sources: ModuleSource[],
  fromDir: string,
): ResolvedModule | null {
  // Resolve from the project, not from this package: ESLint runs there and loads plugins from there.
  const require = createRequire(join(fromDir, "package.json"));
  for (const source of sources) {
    try {
      const url = pathToFileURL(require.resolve(source.specifier)).href;
      return { url, member: source.member };
    } catch {
      continue;
    }
  }
  return null;
}
