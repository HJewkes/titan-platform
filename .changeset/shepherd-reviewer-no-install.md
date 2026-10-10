---
"@titan-design/factory": patch
---

On basement, the Shepherd reviewer brief now says never to install dependencies in the review checkout, and to run targeted tests with `basement-suite <repo> <branch> --agent <name> -- <paths>`. A titan-platform review checkout drops from about 102k inodes to about 3k.
