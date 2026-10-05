# @titan-design/style-profile

Declare one code-style profile and export it as enforcement artifacts: an ESLint config, a
ruff config, an EditorConfig, Claude rules, Claude hooks, a Claude skill, and a markdown
style guide. Written standards become linters.

Tier 2 of the titan-platform DAG (TP-131). No titan dependencies. `zod` v4 is a peer;
`handlebars` is a regular dependency and renders the skill templates shipped in
`templates/`.

```sh
npm install @titan-design/style-profile zod
```

## Profile

A profile is a JSON document validated by `ProfileSchema`. Six categories (`naming`,
`structure`, `documentation`, `errorHandling`, `formatting`, `patterns`) each map a rule
name to a `StyleRule`:

```ts
{ convention: "camelCase", confidence: 0.93, stability: "high", fixability: "safe",
  description: "...", examples: [{ good: "...", bad: "..." }],
  extensions: { eslint: { rule: "no-throw-literal" }, ruff: { codes: ["E501"] } } }
```

`confidence` decides severity through `severityThresholds` (default error 0.85, warn 0.60,
info 0.40). A rule below `info` is left out of every export.

`readProfile(path)` and `writeProfile(path, profile)` parse through the schema;
`validateProfile(data)` returns zod's `safeParse` result. `migrateProfile` walks the
migrations registered with `registerMigration` up to `SCHEMA_VERSION` (`1.0.0`, none
registered yet).

## Export

```ts
import { exportProfile, readProfile, SUPPORTED_FORMATS } from "@titan-design/style-profile";

const profile = await readProfile("code-style-profile.json");
for (const file of exportProfile(profile, "ruff")) {
  // file.path is relative to the target repo, file.content is the full text
}
```

| Format | Files |
|---|---|
| `eslint` | `eslint.config.js` |
| `ruff` | `ruff.toml` |
| `editorconfig` | `.editorconfig` |
| `markdown` | `style-guide.md` |
| `claude-rules` | `.claude/rules/typescript.md` (none when no rule clears `info`) |
| `hooks` | `.claude/codewatch-hooks.json` (a fragment to merge into `.claude/settings.json`) |
| `skill` | `skill.md`, `references/naming.md`, `references/patterns.md`, `references/per-language/<lang>.md` |

`exportProfile(profile, "hooks")` returns one file, `.claude/codewatch-hooks.json`. It is a
fragment in Claude Code's event-keyed hooks shape, not a whole settings file, so writing it
never replaces an existing `.claude/settings.json`. Append its `PostToolUse` entry to your
settings:

```sh
jq -s '.[0].hooks.PostToolUse += .[1].hooks.PostToolUse | .[0]' \
  .claude/settings.json .claude/codewatch-hooks.json > settings.tmp \
  && mv settings.tmp .claude/settings.json
```

The hook fires after every `Write` or `Edit`. Claude Code passes the tool call as JSON on
stdin; the command reads `tool_input.file_path` from it with `jq` and runs
`codewatch check --fix <file>`, so both `jq` and `codewatch` must be on `PATH`.

Each format also has its own generator (`generateEslintExport`, `generateRuffExport`, and so
on). The rule builders in `eslint-rules` (`buildNamingConventionRule`,
`buildFunctionLengthRule`, `buildFileNamingRule`, `buildJsdocRules`, `buildImportOrderRule`)
return single `[ruleName, config]` pairs for callers that assemble their own ESLint config.
`buildNamingConvention` returns the naming rule plus `skippedRules`: profile naming values
are mapped to typescript-eslint formats (`UPPER_SNAKE_CASE` and `SCREAMING_SNAKE` become
`UPPER_CASE`), and a value with no typescript-eslint format, such as `kebab-case`, is left
out of the rule and reported there with a reason instead of making ESLint reject the config.

## Provenance

Ported from codewatch's `@codewatch/profile`. Generated headers and the hooks command
still name `codewatch`. Every artifact except the hooks fragment is byte-identical to the
original's; the hooks export was rewritten to match Claude Code's settings schema.

The worked example and the gotchas live in the site's reference page,
`site/reference/style-profile.md`.
