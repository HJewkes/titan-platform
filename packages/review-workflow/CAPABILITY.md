# review-workflow: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You review one PR head as a resumable workflow and want its vocabulary: the ports a host satisfies (`ReviewWorkflowPorts`), the injectable step ids (`ReviewStepIds`), the outcome union (`ReviewOutcome`), the member failure classes (`FailureClass`), and `DEFAULT_RETRY_POLICY`, the retry, heal and fixer rule for each class as data, and `healOnce`, one bounded heal pass over the ports. The recipe, preflight and fixer arrive in later releases; to run a panel in memory today use review-panel's `reviewPullRequest`.
