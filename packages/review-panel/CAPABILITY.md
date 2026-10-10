# review-panel: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You start reviewers for a pull request and read their verdicts, and want Shepherd's panel types (`PrFacts`, `PrClass`, `PanelPlan`, `PanelVerdict`), `classifyPr` to class a PR from its paths and kind, `planPanel` to pick its reviewers by shape, profile and blocking flag, the reviewer ports (`ReviewerDispatch`, `ReviewerReader`) your adapters satisfy, `acceptVerdict` to decide whether a reviewer's final message is its verdict for this PR at this head, and `aggregate` to turn the members' verdicts into one fail-closed panel verdict. It runs nothing; to start an agent use agent-dispatch, and to parse a transcript use session-read.
