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
| `generateEslintConfig(profile)`, `EslintFlatConfigEntry` | one flat-config entry for `**/*.ts` and `**/*.tsx` with style-profile's rules (the `info` tier as `warn`), or `[]`; rule data only, plugins are loaded at run time |
| `orchestrate(options)`, `OrchestratorOptions`, `OrchestratorResult` | generate configs, run ESLint on JS/TS files and ruff on Python files, merge diagnostics, count by severity, and return `failures` and `skippedRules` |
| `ToolFailure`, `ToolFailureKind`, `ToolName`, `SkippedRule` | a run that could not check its files, and an ESLint rule left out because its plugin is not installed |
| `parseEslintJsonOutput(json)`, `parseRuffJsonOutput(json)` | normalize a tool's JSON output; throw on non-JSON; rule-less messages are not diagnostics |
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

## Failures and exit codes

`orchestrate` returns `{ diagnostics, failures, skippedRules, summary }`. An empty
`failures` means every tool that ran checked every file it was given, so an empty
`diagnostics` with it really is a clean run. Each failure is
`{ tool, kind, message, file? }`, and its message carries the tool's stderr:

| `kind` | When |
|---|---|
| `spawn-failed` | `npx` or `ruff` could not be started |
| `timeout` | the run outlived its 60-second timeout and was killed |
| `signal` | the process was killed by a signal |
| `exit-code` | an exit code other than 0 or 1 |
| `unparseable-output` | exit 0 or 1 with empty or non-JSON stdout |
| `file-not-checked` | one file was not checked: an ESLint parse error or ignored file, a ruff syntax error (`"code": "invalid-syntax"` in ruff 0.16.8, a null `code` in 0.9.10), or a path ruff could not read, which it reports only on stderr with exit 0 |
| `missing-dependency` | the project has no TypeScript parser, so ESLint was not run |

Exit codes 0 and 1 are both successful runs for both tools. ESLint documents 0 as no
errors, 1 as at least one error, and 2 as a configuration problem or internal error
([CLI reference](https://eslint.org/docs/latest/use/command-line-interface#exit-codes)).
ruff documents 0 as no violations or all fixed, 1 as violations found, and 2 as abnormal
termination from invalid configuration, invalid options or an internal error
([linter docs](https://docs.astral.sh/ruff/linter/#exit-codes)).

## ESLint plugins

ESLint runs in the project, so its plugins must come from the project's `node_modules`.
At run time the runner resolves, from the current working directory, the parser and
each plugin a rule needs, and writes a flat config that imports them by absolute path.
`@typescript-eslint/` rules use `@typescript-eslint/eslint-plugin` or the
`typescript-eslint` meta-package; `perfectionist/`, `unicorn/` and `jsdoc/` rules use
`eslint-plugin-perfectionist`, `eslint-plugin-unicorn` and `eslint-plugin-jsdoc`.

A rule whose plugin is not installed is left out and listed in `skippedRules`, for
example `{ tool: "eslint", rule: "unicorn/filename-case", plugin: "unicorn", reason:
"eslint-plugin-unicorn is not installed in /app" }`. The other rules still run: a profile
mixes core and plugin rules, and one missing plugin should not cost the core checks. The
TypeScript parser (`@typescript-eslint/parser` or `typescript-eslint`) is required.
Without it ESLint cannot parse `.ts`, so the run is not attempted and a
`missing-dependency` failure names the package. `npx --no` stops npx from downloading an
ESLint the project has not installed.

## What it deliberately does not do

- It runs only ruff and ESLint. Other runners (pyright, jscpd, vulture and more) come
  after the port.
- It does not install the tools or plugins. `ruff` must be on `PATH`; ESLint, its
  TypeScript parser and its plugins must be installed in the current working directory's
  project.
- It does not read profiles from disk, choose output formats, or set exit codes. Those
  belong to the product that calls it (codewatch's `check` and `diff` commands).
- It does not list changed files from git. codewatch's CLI keeps that.

## Gotchas

- The generated ESLint config covers only `**/*.ts` and `**/*.tsx`, though `orchestrate`
  sends `.js` and `.jsx` too. A `.jsx` file comes back as `file-not-checked`; a `.js` file
  matches ESLint's defaults, is linted with none of the profile's rules, and comes back
  clean.
- A file outside the current working directory comes back as `file-not-checked` ("File
  ignored because outside of base path").
- `max-complexity` comes from `functionMaxLines`, a line count, not a cyclomatic
  complexity.
- Every ruff diagnostic is `warn`. ruff 0.16.8's own `severity` field is ignored: it is
  `"error"` for every rule finding. ESLint severity 2 is `error`, anything else `warn`.
  `summary.fixed` is always 0.
- `diffAgainstProfile` compares `String(observation.value)` with
  `String(convention)`, and matches `type` against the profile key literally. Analyzer
  types such as `naming.variable` do not match a profile key `variables`.
- `parseEslintJsonOutput` still drops messages with no `ruleId`, and `parseRuffJsonOutput`
  drops syntax-error entries. The runners report the ones that mean a file was not
  checked as failures; other rule-less ESLint messages, such as unused disable
  directives, stay dropped.

## Where it came from

Ported from codewatch's `packages/checker` (TP-135) with behaviour unchanged, plus
`diffAgainstProfile` and its types, moved down from codewatch's `cli/src/commands/diff.ts`.
A differential run over two profiles produced byte-identical ruff and ESLint configs,
runner arguments, written config files, parsed diagnostics and profile diffs from the
original and the port. The source changes are imports, non-null assertions in tests for
`noUncheckedIndexedAccess`, and splitting long functions into helpers.
