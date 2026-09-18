import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildEslintConfigModule } from "./eslint-config-module.js";
import type { EslintFlatConfigEntry } from "../generators/eslint.js";

const dirs: string[] = [];

function fakeProject(packages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "style-checker-project-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(packages)) {
    const pkgDir = join(dir, "node_modules", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, main: "index.js" }));
    writeFileSync(join(pkgDir, "index.js"), body);
  }
  return dir;
}

async function load(dir: string, source: string): Promise<Array<Record<string, unknown>>> {
  const path = join(dir, `config-${dirs.length}.mjs`);
  writeFileSync(path, source);
  return (await import(pathToFileURL(path).href)).default;
}

const PARSER = `module.exports = { name: "fake-parser" };`;
const plugin = (name: string) => `module.exports = { name: "${name}", rules: {} };`;

const config: EslintFlatConfigEntry[] = [{
  files: ["**/*.ts"],
  rules: { "max-lines-per-function": ["warn", { max: 3 }], "unicorn/filename-case": ["error", {}] },
}];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildEslintConfigModule", () => {
  it("registers the TypeScript parser and every plugin the rules name", async () => {
    const dir = fakeProject({ "@typescript-eslint/parser": PARSER, "eslint-plugin-unicorn": plugin("unicorn") });

    const built = buildEslintConfigModule(config, dir);

    expect(built).toMatchObject({ ok: true, ruleCount: 2, skippedRules: [] });
    const [entry] = await load(dir, built.ok ? built.source : "");
    expect(entry).toMatchObject({
      files: ["**/*.ts"],
      rules: config[0]!.rules,
      languageOptions: { parser: { name: "fake-parser" } },
      plugins: { unicorn: { name: "unicorn" } },
    });
  });

  it("skips and reports a rule whose plugin the project has not installed", async () => {
    const dir = fakeProject({ "@typescript-eslint/parser": PARSER });

    const built = buildEslintConfigModule(config, dir);

    expect(built).toMatchObject({ ok: true, ruleCount: 1 });
    expect(built.ok && built.skippedRules).toEqual([{
      tool: "eslint", rule: "unicorn/filename-case", plugin: "unicorn",
      reason: `eslint-plugin-unicorn is not installed in ${dir}`,
    }]);
    const [entry] = await load(dir, built.ok ? built.source : "");
    expect(entry!.rules).toEqual({ "max-lines-per-function": ["warn", { max: 3 }] });
  });

  it("skips a rule from a plugin namespace it has no package for", () => {
    const dir = fakeProject({ "@typescript-eslint/parser": PARSER });

    const built = buildEslintConfigModule([{ rules: { "import/order": "warn" } }], dir);

    expect(built).toMatchObject({ ok: true, ruleCount: 0 });
    expect(built.ok && built.skippedRules[0]!.reason).toMatch(/no known package provides the ESLint plugin "import"/);
  });

  it("falls back to the typescript-eslint meta-package for the parser and plugin", async () => {
    const meta = `module.exports = { parser: { name: "meta-parser" }, plugin: { name: "meta-plugin" } };`;
    const dir = fakeProject({ "typescript-eslint": meta });
    const rules = { "@typescript-eslint/naming-convention": ["error"] };

    const built = buildEslintConfigModule([{ files: ["**/*.ts"], rules }], dir);

    const [entry] = await load(dir, built.ok ? built.source : "");
    expect(entry).toMatchObject({
      languageOptions: { parser: { name: "meta-parser" } },
      plugins: { "@typescript-eslint": { name: "meta-plugin" } },
    });
  });

  it("fails with the parser's package name when TypeScript cannot be parsed", () => {
    const dir = fakeProject({});

    const built = buildEslintConfigModule(config, dir);

    expect(built).toEqual({ ok: false, failure: {
      tool: "eslint", kind: "missing-dependency",
      message: `@typescript-eslint/parser or typescript-eslint is not installed in ${dir}, so ESLint cannot parse TypeScript`,
    } });
  });
});
