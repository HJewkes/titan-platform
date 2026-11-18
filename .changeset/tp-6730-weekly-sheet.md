---
"@titan-design/active-work": minor
"titan-console": minor
---

Add the weekly sheet (TP-5453 P16). `active-work plan sheet generate` writes `<initiative>/plan/sheets/<week>.md` from the initiative's outcomes, bets, scorecard week rows and stored prediction checks, in five sections: statement, moved, not moved, proposed bets and proposed stops. Every bet line names its intent line and metric, and any bet line that cites no intent line is flagged and defaults to hold. A bet with no prediction check reads `unread`. `plan sheet show` reads a sheet back. `plan sheet apply-defaults` records the sheet's defaults as its decisions, and only once the deadline has passed with no answer recorded. Reading a sheet never records anything. The console initiative page shows the newest sheet.
