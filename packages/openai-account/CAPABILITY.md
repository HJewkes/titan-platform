# openai-account: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need token-free Codex account state from an explicit CODEX_HOME: parse `codex login status`, validate rollout token_count rate_limits evidence and refuse admission when its observation freshness cannot be verified. Native rollouts return unknown/freshness-unverified; quota age and numerical admission policy require a caller-established known observation. The pure root exports `loginStateFromStatus`, `usageFromRolloutEvents`, `knownObservation`, `quotaAdmission`, `accountLabel` and `redactSecrets`; `./node` exposes the bounded login probe and read-only rollout scan. It never reads auth.json or provisions an account. The opt-in `readNativeUsage` node reader fetches native backend quota over bounded private stdio with an explicit expected account binding and a request-start freshness lower bound; native credential refresh can occur. For Claude account state use anthropic-account; for execution and transcript decoding use agent and session-read.

Use `knownObservation` to explicitly attest a quota observation time source before admission; plain or serialized known readings do not carry that process-local provenance. The factory does not authenticate a backend or account.

The explicit `openai-account status --statusline --expected-account-id <binding>` command opts into that native reader with caller-established identity and emits the existing Codex statusline ABI, or unknown without a valid binding.
