---
"@titan-design/factory": minor
---

`gate resolve` in a shell agent-chat launched asks for owner presence before it resolves as the owner. A confirmed dialog resolves as `owner-terminal` with the proof id as `confirmEvent`; no proof resolves as `coordinator`, named by `AGENT_CHAT_NAME`, which hitl refuses. The dialog reason is built only from a gate id, decision and head sha that pass strict shapes, and a proof must be a v4 UUID. The owner-presence helper now builds into `native/build`, outside `dist`, so `pnpm build` no longer deletes it. `resolveGate` is async.

After this release, rerun `pnpm factory:install` (or `node scripts/factory-build-helper.mjs`) on the machine. `service deploy` only installs and builds, so it leaves `native/build/owner-presence` missing, and until the helper is compiled every resolve from a shell with `AGENT_CHAT_AGENT_ID`, including the owner's `!` command, is refused as `coordinator`. The dialog does not yet stop an agent that only runs the CLI: `env -u AGENT_CHAT_AGENT_ID` or an empty value still resolves as `owner-terminal` with no dialog, until the owner decides whether every resolve asks for presence.
