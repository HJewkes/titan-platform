---
"titan-console": minor
---

Rounds: a sent round reads back as sent (TP-3767). `rounds.get` returns every sent answer (`notes.answers`: pick, picks, value, text, revisionRequested, optionNotes, recommendationSeen) and the Addressed ticks from `addressed.json` (`notes.addressed`), and an open or sent Ship round carries its earlier feedback. After a reload, question, design and Ship rounds show every question locked with its sent answer marked, A/B option notes read-only, the Ship pick and the Addressed ticks. Round text renders as markdown (TP-3768): the round and section context, each section's Deciding, Changed and Context (now labelled), recommendation rationale through react-ui's `MarkdownProse`, and prompts and options inline. Links open only for http(s), mailto and relative targets; any other target, `javascript:` included, shows its text and links nowhere.
