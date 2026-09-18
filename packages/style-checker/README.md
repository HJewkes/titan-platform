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

const { diagnostics, summary } = await orchestrate({ profile, files: ["src/app.ts", "app.py"] });
// diagnostics: [{ file: "app.py", line: 5, column: 4, severity: "warn", category: "naming", rule: "N806", ... }]
```

## API

- `generateRuffConfig(profile)` returns a `RuffConfig`. It selects `N`, `I`, `D` and `C90`
  for naming, import order, function docs and function length that clear the profile's
  `info` threshold, and carries `line-length`, isort section order, pydocstyle convention
  and mccabe max complexity.
- `generateEslintConfig(profile)` returns an `EslintFlatConfigEntry[]`: one entry for
  `**/*.ts` and `**/*.tsx` holding the rules style-profile's rule builders produce, or an
  empty array when there are none.
- `orchestrate({ profile, files, fix?, language? })` picks the files by extension, runs
  ESLint (through `npx eslint`) on `.ts`, `.tsx`, `.js`, `.jsx` and ruff on `.py`, and
  returns `{ diagnostics, summary }`. A tool is skipped when its generated config is empty.
  `language` restricts it to one tool; otherwise it is detected from the file list.
- `parseEslintJsonOutput(json)` and `parseRuffJsonOutput(json)` turn each tool's
  `--format json` output into `CheckDiagnostic[]`. Both throw on output that is not JSON.
- `formatDiagnostic(d)` prints `file:line:column severity message [category.rule]`.
- `diffAgainstProfile(profile, observations)` compares each observation's value with the
  profile's convention for its `type` and returns `{ deviations, summary }`. Observations
  whose type has no profile rule count toward `total` but neither match nor deviate.
- Types: `CheckDiagnostic`, `CheckResult`, `OrchestratorOptions`, `OrchestratorResult`,
  `RuffConfig`, `EslintFlatConfigEntry`, `Deviation`, `DiffResult`, and `Severity`
  (re-exported from style-profile).

Which runners fire, with which configs, is product policy. The runner seam is one
function per tool (`runEslint`, `runRuff`) over a shared `runTool` spawn helper; new
runners are added beside them.

## Gotchas

- ESLint 9 rejects the generated flat config: it names plugin rules
  (`@typescript-eslint/…`, `perfectionist/…`, `unicorn/…`, `jsdoc/…`) but loads no plugins.
  The runner reads only stdout, so the failure surfaces as zero diagnostics, not an error.
- ruff's `max-complexity` is set from the profile's `functionMaxLines`, a line count, not a
  cyclomatic complexity.
- Every ruff diagnostic has severity `warn`. ESLint severity 2 maps to `error`, anything
  else to `warn`. Nothing produces `info`.
- `summary.fixed` is always 0, even with `fix: true`.
