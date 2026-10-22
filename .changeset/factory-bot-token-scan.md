---
"@titan-design/factory": minor
---

`titan-factory bot-token scan` checks A17, the bot's token is absent from every agent environment. When serve reads the bot token it writes the token's SHA-256 to `bot-token.sha256` in its state dir, mode 0600, and removes a stale one when it holds none. The scan, run as the agents' uid, hashes every `ghp_` and `github_pat_` shaped string in this uid's `/proc/<pid>/environ` files, agent-chat briefs, serve and agent logs, transcripts and every row of the factory store, and names each hit by place, never by value. Every place is a flag, so tests run on fixture dirs. It exits 0 when clean, 1 on a hit and 69 with no fingerprint.
