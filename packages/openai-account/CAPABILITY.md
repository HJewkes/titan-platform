# openai-account: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need token-free Codex account state from an explicit CODEX_HOME: parse `codex login status`, read quota from rollout token_count rate_limits observations, measure its age and refuse automatic runs on missing, inconsistent, stale or exhausted quota. The pure root exports `loginStateFromStatus`, `usageFromRolloutEvents`, `quotaAdmission`, `accountLabel` and `redactSecrets`; `./node` exposes the bounded login probe and read-only rollout scan. It never reads auth.json or provisions an account. For Claude account state use anthropic-account; for execution and transcript decoding use agent and session-read.
