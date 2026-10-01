---
"@titan-design/hitl": patch
---

Tests and README now pin the rule-bound insert guard against raw SQL. A rule-less `INSERT ON CONFLICT DO UPDATE`, `DO NOTHING`, `INSERT OR IGNORE` or plain duplicate insert onto a pending rule-bound id aborts with the guard message, because the trigger fires before conflict handling. A raw `REPLACE` of a cancelled rule-bound row still yields a pending rule-less row; the README states that is outside the store API. No behaviour change.
