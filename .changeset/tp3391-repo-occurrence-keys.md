---
"@titan-design/factory": patch
---

The event log can derive occurrence keys for `PRMerged`, `PRClosed`, `ReviewSubmitted`, `ReviewDismissed` and `RulesChanged`, and transition observations for `HeadPushed`, `BaseChanged` and `MainMoved`, from a webhook delivery or the GraphQL backstop's shape (TP-3391, TP-3095 S3). Nothing reads or emits them yet.
