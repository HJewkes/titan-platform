---
"@titan-design/authority": minor
---

Add the `decider` actor class and the `answer-question` action class. The decider is denied every action except `answer-question`, which the conditional ANS-DC-QA row allows only when `facts.question` names a `question` rule kind in `auto` mode on an untainted request; every other actor is denied `answer-question`. `decider` is never a resolver. Adds the `gate-rule-is-question` and `category-mode-auto` conditions, the `QuestionFacts` type, and `MERGE_CONDITION_KINDS` and `QUESTION_CONDITION_KINDS`.
