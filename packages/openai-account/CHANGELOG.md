# @titan-design/openai-account

## 0.1.0

### Minor Changes

- c932928: Add read-only Codex account state: model-free login-status probing, rollout quota
  readings with observation age, fail-closed admission thresholds and secret redaction.
- 3e323bd: Require explicitly named observation provenance through knownObservation before a known quota reading can enter admission. Reject malformed statuses/readings without throwing, preserve rollout unknown freshness and quota thresholds, and test duration mapping through actual parsed evidence.

### Patch Changes

- c932928: Refuse quota admission from native rollout timestamps: cached token_count re-emissions do not establish a fresh server observation. Valid raw rollout evidence now returns unknown/freshness-unverified without an age; caller-established known readings retain the existing quota policy.
