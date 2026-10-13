---
"@titan-design/tool-guard": patch
---

curl, wget and httpie sending a write method to a URL whose host, or whose `api.github.com` path, is known only at run time now classify as `bash.merge.curl-api {}` (TP-2728 b). The request reader fails closed: a run-time or lower-case httpie method, a write in any `--next` request, a URL it cannot see (xargs, `wget -i`, none given) and a globbed or `--expand-url` URL all count as run-time. curl options are read against curl's full option list: `--expand-<opt>` reads as `<opt>` with `{{var}}` run-time, `--no-<switch>` turns a switch off (last wins), and an unknown option, `-K` or `--request-target` makes the method and URL unknown.
