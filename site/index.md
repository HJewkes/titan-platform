---
layout: home

hero:
  name: titan-platform
  text: A multi-agent software factory, and the shared packages it is built from.
  tagline: <!-- generated:package-count start -->60<!-- generated:package-count end --> packages and <!-- generated:test-file-count start -->2,000+<!-- generated:test-file-count end --> test files, with the products composed from them.
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
  - title: Each tool keeps its own data
    details: Small building blocks for storing data in SQLite, with history and search included. Each product installs them into its own file.
    link: /reference/store-sqlite
  - title: Write a command once
    details: Define a command a single time and get a command line, an MCP tool list, and an HTTP route from it.
    link: /reference/registry
  - title: Search that keeps working
    details: Keyword, meaning-based, and link-based search are combined. If one of them fails, results get thinner and the failure is reported, but search still answers.
    link: /reference/retrieval
  - title: Past sessions you can search
    details: Claude Code transcripts become sessions, turns, tokens, files, branches, and PRs, kept current as the transcripts grow.
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
| To run the factory, Shepherd, or another product | [Running the products](/guides/#running-the-products) |
| To add a package or cut a release | [Working in the repo](/guides/contributing) |

## Under the hood

The terms the rest of the site uses, and where they come from.

- **Strict acyclic DAG.** Packages sit in tiers, and a package may import only its own tier or
  a lower one, so the dependency graph has no cycles. See [Architecture](/guides/architecture).
- **Bi-temporal edges.** The storage kit records each link between two things with both the
  time it was true and the time it was recorded, so history can be queried as it was known.
  See [store-sqlite](/reference/store-sqlite).
- **Contentless FTS5.** Full-text indexes are SQLite FTS5 tables that hold the search index
  but not a second copy of the text. Watermarks and content-addressed caches round out the
  kit.
- **RRF.** Reciprocal rank fusion merges the ranked lists from the full-text, vector, and
  graph retrievers into one list. A retriever that throws lowers recall and reports itself;
  it never breaks search. See [retrieval](/reference/retrieval).
- **Zod to every surface.** A command is one zod definition that the registry projects onto a
  CLI, an MCP tool list, and an HTTP route, with no parallel schemas. See
  [registry](/reference/registry).
- **Byte watermarks.** The session graph tracks how far into each JSONL transcript it has
  read, so it only reads what was appended. See [session-graph](/reference/session-graph).
