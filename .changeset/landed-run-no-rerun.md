---
"@titan-design/factory": patch
---

Shepherd no longer reruns a red head's failed jobs when it replays a run recorded before the hold check or the rerun existed, so a run that landed before a serve restart does not touch CI again. A rerun GitHub answers with "cannot be retried" or "already running" is recorded as not rerunnable and the run goes on to the normal wake instead of failing.
