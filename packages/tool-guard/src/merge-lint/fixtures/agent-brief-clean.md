Land the change with seat-merge example-seat example-org/example-repo 42 abc123 /path/to/clone
Read the state with gh pr view 42 and gh pr checks 42
Find the fork point with git merge-base origin/main HEAD
Cancel an auto-merge with gh pr merge 5 --disable-auto
Agents never call merge; only logged paths merge.
