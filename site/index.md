---
layout: home

hero:
  name: titan-platform
  text: Shared parts for agentic tools
  tagline: Fourteen published packages in a strict acyclic DAG, and the products composed thinly on top of them.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Browse the packages
      link: /reference/
    - theme: alt
      text: The binding pattern
      link: /guides/binding-pattern

features:
  - title: Storage without a shared database
    details: A kit of SQLite table factories — bi-temporal edges, contentless FTS5, watermarks, content-addressed caches — that each product installs into its own file.
    link: /reference/store-sqlite
  - title: One command, every surface
    details: Define a command once with zod and project it onto a CLI, an MCP tool list, and an HTTP route. No parallel schemas.
    link: /reference/registry
  - title: Retrieval that degrades
    details: Full-text, vector, and graph retrievers fused with RRF. A retriever that throws lowers recall and reports itself; it never breaks search.
    link: /reference/retrieval
  - title: Transcripts as a graph
    details: Turn Claude Code's JSONL transcripts into sessions, turns, tokens, files, branches, and PRs, kept current from byte watermarks.
    link: /reference/session-graph
---

## What this is

Four sibling projects — **brain**, **active-work**, **codewatch**, and a session miner —
each independently grew the same concerns: SQLite storage with full-text search and a
graph of edges, hybrid retrieval, headless agent triggering, a command registry exposed as
CLI and MCP and HTTP, session-log mining, human-in-the-loop pauses, workflow
orchestration.

titan-platform is where those concerns get factored out. Each one becomes a published
`@titan-design/*` package with a single job, arranged so that a package may import only
its own tier or a lower one. The old projects then shrink: they keep their own commands,
their own domain rules, and their own names, and get the machinery from npm.

This is mostly an *extraction* problem rather than a build problem. Almost every package
here started as working code in one of those four projects, and the extraction notes in
each package's page say which one and what was deliberately left behind.

## Who it is for

**You are building an agentic tool** and you need one of the parts: a durable
human-approval gate, a Drain clusterer for tool errors, a byte-offset provenance scheme, a
daemon that speaks MCP and HTTP over the same command definitions. Install that one
package. Nothing here requires adopting the rest.

**You are working on one of the four projects** and want to replace hand-rolled machinery
with a package. Read [the binding pattern](/guides/binding-pattern) first — it is the
technique that makes an adoption a hundred-line diff instead of a rewrite — and then
[the case study](/guides/adopting-a-package) of the adoption that took active-work's
server from 1,302 lines to 632 with its 1,321 tests unchanged.

**You are contributing here.** [Working in the repo](/guides/contributing) has the DAG
rules, the scaffold, the changeset requirement, and the release flow.

## Where to start

| If you want | Go to |
| --- | --- |
| To install one package and use it | [Get started](/getting-started) |
| To know what each package does | [Packages](/reference/) |
| To understand the tiers and why they are enforced | [Architecture](/guides/architecture) |
| To see the whole DAG working end to end | [Case study: the session miner](/guides/session-miner) |
| To add a package or cut a release | [Working in the repo](/guides/contributing) |
