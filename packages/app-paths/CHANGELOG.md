# @titan-design/app-paths

## 0.2.0

### Minor Changes

- 8a69e02: Add `consoleAnswersPath`: the titan console's `answers.jsonl` owner-answer ledger, under `TITAN_CONSOLE_STATE` or the default console state directory.
- e5d8d29: Export `consoleInboxDir` and `scorecardStorePath` from app-paths and use them in place of the per-product copies (TP-5809). The console inbox spool now expands a leading `~` in `TITAN_CONSOLE_STATE` in yt-scout, and the factory's eligibility check expands a `~` in `TITAN_SCORECARD_STORE`; the other resolutions are unchanged.

## 0.1.0

### Minor Changes

- cb137e3: Add `@titan-design/app-paths`: `appDirs`, `appDataRoot`, `ACTIVE_WORK`, `activeWorkRoot` and `activeWorkGraphPath`, pure path resolvers for an app's per-user directories and active-work's data root, with injectable `{ env, home, platform }`.
