#!/usr/bin/env bash
# Fixture micro rung for the autoresearch tests: usage fake_micro.sh <policy.json> <tree> <rung>.
# The newest line of the tree's applied.txt is the idea under test; its policy entry says whether
# the micro signal moves the predicted way (the default is yes). `usd.micro` is its spend.
set -euo pipefail
exec node -e '
const { readFileSync } = require("node:fs");
const [policyPath, tree, rung] = process.argv.slice(1);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const newest = readFileSync(`${tree}/applied.txt`, "utf8").split("\n").filter(Boolean).at(-1);
const met = policy.mechanisms[newest]?.micro ?? true;
process.stdout.write(JSON.stringify({ schema: "ar-micro/v1", rung, predicted_direction_met: met, usd: policy.usd?.micro ?? 0 }));
' "$@"
