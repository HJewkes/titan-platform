---
"@titan-design/session-read": minor
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

An adversary Authority label glued to an identifier character is still a reading (TP-6624). `Authority-gate: widened` and
`Authority_level: widened` read widened, and any other line whose fold starts `authority` (`Authority-widens: ...`, an
`authorityLevel` lead) reads malformed, so it can never sit beside `Authority: unchanged` unread. session-read exports
`foldLabelledLine`; its CI-policy reading does not change. Factory bumps `sh-await-verdict`, whose output changes for such
replies.
