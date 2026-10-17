When CI is green, run `gh pr merge 42 --squash --delete-branch` and report.
    gh pr merge 42 --squash --delete-branch
Or in one go: gh -R example-org/example-repo pr merge 7 --auto
gh api -X PUT repos/example-org/example-repo/pulls/7/merge -f sha=abc123
gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "X"}) { clientMutationId } }'
await octokit.rest.pulls.merge({ owner: "example-org", repo: "example-repo", pull_number: 7 });
If you would rather wait for the reviewer, then gh pr
merge 9 yourself.

Report the result to the coordinator when you are done.
