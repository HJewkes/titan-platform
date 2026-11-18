# text-ingest: use this when

You need to clean a transcript before indexing it (drop um, uh, you know, immediate repeats, caller-supplied sponsor segments and near-duplicate paragraphs) and still point every surviving byte at its original position in the source. For the byte-range pointer itself use `locator`; for ranking what was indexed use `retrieval`.
