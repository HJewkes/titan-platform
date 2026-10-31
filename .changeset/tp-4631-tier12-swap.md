---
"@titan-design/agent": patch
"@titan-design/agent-dispatch": patch
"@titan-design/agent-surface": patch
"@titan-design/code-graph": patch
"@titan-design/coordinator": patch
"@titan-design/daemon": patch
"@titan-design/health": patch
"@titan-design/matrix-bus": patch
"@titan-design/messaging": patch
"@titan-design/queue-mirror": patch
"@titan-design/rpc-client": patch
"@titan-design/session-analytics": patch
"@titan-design/session-read": patch
"@titan-design/speech-g2p": patch
"@titan-design/speech-stt": patch
"@titan-design/speech-tts": patch
"@titan-design/workflow": patch
---

Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
