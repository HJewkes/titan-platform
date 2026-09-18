# style-checker

**Tier 2.** Depends on `style-profile` and `style-analyzer` (both tier 2; the analyzer for
the `Observation` type only). `zod` v4 is a peer dependency.

```sh
npm install @titan-design/style-checker zod
```

## The problem it solves

A style profile says how code should look. Enforcing it means running real linters, each
with its own config format and its own output format. Before this package, the code that
translated a profile into ruff and ESLint configs, ran both tools, and normalized their
output lived only in codewatch. This package provides that mechanism: one call turns a
profile into tool configs, runs the tools, and returns every finding as a `CheckDiagnostic`
with the same fields whichever tool found it. A second, tool-free path compares
style-analyzer observations directly with a profile.

## When to reach for it

- You have a style profile and want lint findings for a set of files in one shape.
- You want the ruff or ESLint config a profile implies, without running anything.
- You have ESLint or ruff JSON output from elsewhere and want it normalized.
- You have observations from `style-analyzer` and want to know which ones break the
  profile, and how severely.

Building a profile from code lives in `style-analyzer`. Exporting a profile as config files,
rules and docs for other tools lives in `style-profile`.

## Public API

| Export | What it does |
|---|---|
| `generateRuffConfig(profile)`, `RuffConfig` | ruff `select` codes (`N`, `I`, `D`, `C90`), isort section order, pydocstyle convention, mccabe max complexity, `line-length` |
| `generateEslintConfig(profile)`, `EslintFlatConfigEntry` | one flat-config entry for `**/*.ts` and `**/*.tsx` with style-profile's rules, or `[]` |
| `orchestrate(options)`, `OrchestratorOptions`, `OrchestratorResult` | generate configs, run ESLint on JS/TS files and ruff on Python files, merge diagnostics, count by severity |
| `parseEslintJsonOutput(json)`, `parseRuffJsonOutput(json)` | normalize a tool's JSON output; throw on non-JSON |
| `formatDiagnostic(d)` | `file:line:column severity message [category.rule]` |
| `CheckDiagnostic`, `CheckResult`, `Severity` | the normalized record and its severity (`error`, `warn`, `info`) |
| `diffAgainstProfile(profile, observations)`, `Deviation`, `DiffResult` | observations that disagree with the profile's convention, with a severity from the rule's confidence |

## Example

Verified against 0.1.0. A profile in:

```ts
import {
  diffAgainstProfile,
  generateEslintConfig,
  generateRuffConfig,
  parseRuffJsonOutput,
} from "@titan-design/style-checker";

const profile = {
  schemaVersion: "1.0.0", author: "me", generated: "2026-09-18", sources: [],
  naming: { variables: { convention: "camelCase", confidence: 0.94, stability: "high" } },
  structure: { functionMaxLines: { convention: 30, confidence: 0.78 } },
  documentation: { functionDocs: { convention: "google", confidence: 0.85 } },
  errorHandling: {}, formatting: { lineLength: { convention: 100, confidence: 0.9 } },
  patterns: {}, idioms: { detected: [] }, antiPatterns: { acknowledged: [] }, overrides: [],
  severityThresholds: { error: 0.85, warn: 0.6, info: 0.4 },
};
```

A ruff config out. `generateRuffConfig(profile)` returns
`{ lint: { select: ["N", "D", "C90"], pydocstyle: { convention: "google" }, mccabe:
{ "max-complexity": 30 } }, "line-length": 100 }`, and the ruff runner writes it as:

```toml
line-length = 100
[lint]
select = ["N", "D", "C90"]
[lint.mccabe]
max-complexity = 30
[lint.pydocstyle]
convention = "google"
```

An ESLint config out. `generateEslintConfig(profile)` returns:

```json
[{ "files": ["**/*.ts", "**/*.tsx"],
   "rules": {
     "@typescript-eslint/naming-convention": ["error", { "selector": "variable", "format": ["camelCase"] }],
     "max-lines-per-function": ["warn", { "max": 30 }] } }]
```

Diagnostics normalized. `orchestrate({ profile, files })` runs the tools and parses their
output; the parsers work on captured output too:

```ts
const [d] = parseRuffJsonOutput(ruffStdout);
// { file: "app.py", line: 5, column: 4, severity: "warn",
//   message: "Variable `userId` in function should be lowercase",
//   category: "naming", rule: "N806", fixable: false }
formatDiagnostic(d);
// app.py:5:4 warn Variable `userId` in function should be lowercase [naming.N806]
```

Observations diffed, no tool needed:

```ts
diffAgainstProfile(profile, [
  { type: "naming.variables", category: "naming", value: "camelCase", file: "a.ts", line: 3 },
  { type: "naming.variables", category: "naming", value: "snake_case", file: "a.ts", line: 9 },
  { type: "control-flow.guard-clause", category: "control-flow", value: true, file: "a.ts", line: 4 },
]);
// { deviations: [{ file: "a.ts", line: 9, rule: "naming.variables",
//                  expected: "camelCase", found: "snake_case", severity: "error" }],
//   summary: { total: 3, matching: 1, deviating: 1 } }
```

## What it deliberately does not do

- It runs only ruff and ESLint. Other runners (pyright, jscpd, vulture and more) come
  after the port.
- It does not install the tools. `ruff` must be on `PATH`; ESLint runs through `npx eslint`
  from the current working directory.
- It does not read profiles from disk, choose output formats, or set exit codes. Those
  belong to the product that calls it (codewatch's `check` and `diff` commands).
- It does not list changed files from git. codewatch's CLI keeps that.

## Gotchas

- The generated ESLint config names plugin rules but loads no plugins, so ESLint 9 exits
  with a configuration error. The runner reads only stdout and returns zero diagnostics
  rather than throwing.
- `max-complexity` comes from `functionMaxLines`, a line count, not a cyclomatic
  complexity.
- Every ruff diagnostic is `warn`. ESLint severity 2 is `error`, anything else `warn`.
  `summary.fixed` is always 0.
- `diffAgainstProfile` compares `String(observation.value)` with
  `String(convention)`, and matches `type` against the profile key literally. Analyzer
  types such as `naming.variable` do not match a profile key `variables`.
- The eslint JSON parser drops messages with no `ruleId`, which includes parse errors and
  "file ignored" warnings.

## Where it came from

Ported from codewatch's `packages/checker` (TP-135) with behaviour unchanged, plus
`diffAgainstProfile` and its types, moved down from codewatch's `cli/src/commands/diff.ts`.
A differential run over two profiles produced byte-identical ruff and ESLint configs,
runner arguments, written config files, parsed diagnostics and profile diffs from the
original and the port. The source changes are imports, non-null assertions in tests for
`noUncheckedIndexedAccess`, and splitting long functions into helpers.
