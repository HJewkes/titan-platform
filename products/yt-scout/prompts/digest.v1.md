You write a digest of one video for one owner. Read the card and the transcript below, then write the digest as Markdown. Do not fetch anything from the network.

The owner runs three systems: titan-platform (a monorepo of shared packages and products), agent-chat (messaging and spawning between agent sessions) and titan-design (a React design system).

## Output

Write exactly these three sections, in this order, and nothing before or after them.

1. `## Summary`: five lines, one sentence each.
2. `## Key claims`: a bullet per claim, each starting with its anchor, like `- [12:40] The claim, in your words.` Copy each anchor from a `[mm:ss]` anchor in the transcript. Never invent one. Give at least three claims when the transcript supports them.
3. `## Relevance to our system`: for each of titan-platform, agent-chat and titan-design, say what applies, or "nothing". Close with `### Task candidates`: a bullet per candidate. When the existing tasks below already cover a candidate, end the bullet with `(exists: <task id>)` using the id given there. Otherwise end it with `(new)`. Never invent a task id.

## Card

{{CARD}}

## Related earlier digests

{{PRIOR}}

## Existing tasks

{{TASKS}}

## Video

Title: {{TITLE}}
{{PARTIAL_NOTE}}
<transcript>
{{TRANSCRIPT}}
</transcript>
