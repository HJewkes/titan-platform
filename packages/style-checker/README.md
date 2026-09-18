# @titan-design/style-checker

Runs external lint tools against configs generated from a style profile, and normalizes
their output into one diagnostic shape. A profile goes in; a ruff config and an ESLint flat
config come out; ruff and ESLint run over the files; their JSON output comes back as
`CheckDiagnostic` records with a file, line, column, severity, category and rule. It also
diffs a file's style observations against a profile, without any external tool.

Tier 2 of the titan-platform DAG (TP-135). Depends on `@titan-design/style-profile` and
`@titan-design/style-analyzer` (both tier 2; the analyzer only for the `Observation` type).
`zod` v4 is a peer because style-profile needs it at runtime. Ported unchanged from
codewatch's `@codewatch/checker`, plus `diffAgainstProfile` from codewatch's CLI.

```sh
npm install @titan-design/style-checker zod
```

```ts
import { generateRuffConfig, orchestrate } from "@titan-design/style-checker";

generateRuffConfig(profile);
// { lint: { select: ["N", "D", "C90"], pydocstyle: { convention: "google" }, mccabe: { "max-complexity": 30 } }, "line-length": 100 }

const { diagnostics, failures, skippedRules, summary } = await orchestrate({
  profile,
  files: ["src/app.ts", "app.py"],
});
// diagnostics: [{ file: "app.py", line: 5, column: 4, severity: "warn", category: "naming", rule: "N806", ... }]
// failures: [] means every tool that ran checked every file it was given
// skippedRules: [{ tool: "eslint", rule: "unicorn/filename-case", plugin: "unicorn", reason: "eslint-plugin-unicorn is not installed in /app" }]
```

## API

- `generateRuffConfig(profile)` returns a `RuffConfig`. It selects `N`, `I`, `D` and `C90`
  for naming, import order, function docs and function length that clear the profile's
  `info` threshold, and carries `line-length`, isort section order, pydocstyle convention
  and mccabe max complexity.
- `generateEslintConfig(profile)` returns an `EslintFlatConfigEntry[]`: one entry for
  `**/*.ts` and `**/*.tsx` holding the rules style-profile's rule builders produce, or an
  empty array when there are none. It is data: rule names and options, with no plugin
  objects and no parser. Style-profile's `info` tier becomes `warn`, because ESLint accepts
  only `off`, `warn` and `error`.
- `orchestrate({ profile, files, fix?, language? })` picks the files by extension, runs
  ESLint (through `npx --no -- eslint`) on `.ts`, `.tsx`, `.js`, `.jsx` and ruff on `.py`,
  and returns `{ diagnostics, failures, skippedRules, summary }`. A tool is skipped when
  its generated config is empty. `language` restricts it to one tool; otherwise it is
  detected from the file list.
- `parseEslintJsonOutput(json)` and `parseRuffJsonOutput(json)` turn each tool's
  `--format json` output into `CheckDiagnostic[]`. Both throw on output that is not JSON.
  Messages with no rule (ESLint parse errors and ignored files) and ruff syntax errors
  (`"code": "invalid-syntax"` in ruff 0.16.8, a null `code` in 0.9.10) are not
  diagnostics; the runners report them as `file-not-checked` failures.
- `formatDiagnostic(d)` prints `file:line:column severity message [category.rule]`.
- `diffAgainstProfile(profile, observations)` compares each observation's value with the
  profile's convention for its `type` and returns `{ deviations, summary }`. Observations
  whose type has no profile rule count toward `total` but neither match nor deviate.
- Types: `CheckDiagnostic`, `CheckResult`, `OrchestratorOptions`, `OrchestratorResult`,
  `ToolFailure`, `ToolFailureKind`, `ToolName`, `SkippedRule`, `RuffConfig`,
  `EslintFlatConfigEntry`, `Deviation`, `DiffResult`, and `Severity` (re-exported from
  style-profile).

## Failures

A run that could not check the files is never reported as a clean run. Each problem
becomes a `ToolFailure` (`{ tool, kind, message, file? }`) in `failures`; the message
carries the tool's stderr. `diagnostics: []` with `failures: []` means the tools ran and
found nothing.

| `kind` | When |
|---|---|
| `spawn-failed` | the executable (`npx`, `ruff`) could not be started |
| `timeout` | the run outlived its timeout (60 s) and was killed |
| `signal` | the process was killed by a signal |
| `exit-code` | an exit code other than 0 or 1 |
| `unparseable-output` | exit 0 or 1 with empty or non-JSON stdout |
| `file-not-checked` | the tool ran but could not check one file (`file` names it): an ESLint parse error or ignored file, a ruff syntax error, or a path ruff could not read (which it reports only on stderr, with exit 0) |
| `missing-dependency` | no TypeScript parser in the project, so ESLint was not run |

An unreadable ruff path is detected by matching ruff's stderr warning `warning: Failed to
lint <path>: <reason>`, captured from ruff 0.16.8. ruff has no structured signal for it
and does not treat the wording as stable; if a later ruff rewords it, that case goes
silent again.

Exit codes 0 and 1 are both successful runs. ESLint documents 0 as no errors, 1 as at
least one error, and 2 as a configuration problem or internal error
([CLI reference](https://eslint.org/docs/latest/use/command-line-interface#exit-codes)).
ruff documents 0 as no violations (or all fixed), 1 as violations found, and 2 as abnormal
termination from invalid configuration, invalid options or an internal error
([linter docs](https://docs.astral.sh/ruff/linter/#exit-codes)).

## ESLint plugins

The checker runs ESLint in the project (the current working directory), so plugins must
come from the project's own `node_modules`. At run time it resolves each plugin a rule
needs from that directory and writes a config that imports it by absolute path:

| Rule prefix | Package |
|---|---|
| `@typescript-eslint/` | `@typescript-eslint/eslint-plugin`, or `typescript-eslint` |
| `perfectionist/` | `eslint-plugin-perfectionist` |
| `unicorn/` | `eslint-plugin-unicorn` |
| `jsdoc/` | `eslint-plugin-jsdoc` |

A rule whose plugin is not installed is left out of the run and listed in `skippedRules`
with the package it needs; the rest of the rules still run. The TypeScript parser
(`@typescript-eslint/parser`, or `typescript-eslint`) is required: without it ESLint
cannot parse `.ts`, so the run is not attempted and a `missing-dependency` failure names
the package. `npx --no` stops npx from downloading an ESLint the project does not have.

Which runners fire, with which configs, is product policy. The runner seam is one
function per tool (`runEslint`, `runRuff`) over a shared `runTool` spawn helper; new
runners are added beside them.

## Gotchas

- The generated ESLint config covers only `**/*.ts` and `**/*.tsx`, though `orchestrate`
  sends `.js` and `.jsx` to ESLint too. A `.jsx` file comes back as a `file-not-checked`
  failure. A `.js` file matches ESLint's built-in defaults, so it is linted with none of
  the profile's rules and comes back clean.
- ESLint runs from the current working directory. A file outside it comes back as a
  `file-not-checked` failure ("File ignored because outside of base path").
- ruff's `max-complexity` is set from the profile's `functionMaxLines`, a line count, not a
  cyclomatic complexity.
- Every ruff diagnostic has severity `warn`. ESLint severity 2 maps to `error`, anything
  else to `warn`. Nothing produces `info`. ruff 0.16.8 emits a `severity` field, but it is
  `"error"` for every rule finding, so it is ignored.
- `summary.fixed` is always 0, even with `fix: true`.
