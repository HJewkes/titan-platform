# egress-scan: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

Text is about to leave the machine for a public repo and you must refuse absolute home paths, active-work data directory paths, terms from a private list or credential tokens (GitHub, Anthropic, AWS, Slack, PEM private keys), reporting only `file:line`, the rule id and the token kind. The root export scans git patch text you supply and spawns nothing; the `titan-egress-scan` bin runs git for a pre-push hook (`install-hook`) or a CI range; `/hooks` writes a spawn-time hooks dir whose pre-push scans with the scanner on a baked PATH and, for no-rewrite agents, refuses deletes, main updates and non-fast-forwards. To mask secrets for display, use the redactors in queue-mirror instead.
