# review-workflow: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You review one PR head as a resumable workflow and want its vocabulary: the ports a host satisfies (`ReviewWorkflowPorts`), the injectable step ids (`ReviewStepIds`), the outcome union (`ReviewOutcome`), the member failure classes (`FailureClass`), and `DEFAULT_RETRY_POLICY`, the retry, heal and fixer rule for each class as data, and `healOnce`, one bounded heal pass over the ports. `reviewHead` runs it over your step engine, with `REVIEW_STEP_BODIES` as the step bodies. To run a panel in memory with no durable steps, use review-panel's `reviewPullRequest`.
