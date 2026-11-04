# review-burden: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need to say how much a pull request asks of its reviewer, or whether a revert would undo it, from facts alone with no model call. `burdenScore` turns a numstat-shaped file list, the `$tiers` map, the changed `package.json` sides and the PR body into a 0 to 100 score with every part shown; `doorFacts` lists the one-way facts (migration path, major changeset, authority-protected path, removed `exports`/`bin`/`name` key, deleted stored-data path); `parseFooter` reads the author's `<!-- merge-danger:v1 -->` footer. It does no git or GitHub I/O, so a CLI and Shepherd compute the same number; to decide who may merge, use authority.
