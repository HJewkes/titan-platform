---
"@titan-design/code-parser": minor
"@titan-design/code-graph": patch
"@titan-design/style-analyzer": patch
---

Move the shared tree-sitter function and class node-kind table into code-parser, exported from the dependency-free `@titan-design/code-parser/node-kinds` subpath and adding `TS_METHOD_DEFINITION`. code-graph re-exports it unchanged. style-analyzer's complexity extractor builds its function set from those constants instead of restating the strings. No behaviour change.
