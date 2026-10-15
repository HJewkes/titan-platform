# graph-layout: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A product draws a code-graph snapshot as boxes and routed edges: collapse files to packages, directories or one focused package, then lay the result out with ELK layered (flat or nested), with the same coordinates for any input order. For an animated architecture diagram, `emitRepoMap` writes the whole nested map (package, directory and file boxes, routed edges at every level, a sha) as `repo-map/v1` data. For the graph itself use code-graph; for rolled-up values per tree depth use code-read's `hierarchy.get`.
