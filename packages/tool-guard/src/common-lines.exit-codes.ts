import type { CommonLine } from "./common-lines.js";

/** Lines main allows in the "exit codes" family. */
export const exitCodesLines: readonly CommonLine[] = [
  { id: "B01", family: "exit codes", line: "make test; rc=$?; exit $rc" },
  { id: "B02", family: "exit codes", line: 'rc=$?; exit "$rc"' },
  {
    id: "B04",
    family: "exit codes",
    line: "count=$(git status --porcelain|wc -l); ((count>0))",
  },
  {
    id: "B14",
    family: "exit codes",
    line: "npm test; status=$?; [ $status -ne 0 ] && echo failed; exit $status",
  },
  { id: "B19", family: "exit codes", line: "exit $((failures > 0))" },
  {
    id: "B20",
    family: "exit codes",
    line: "f() { make; local rc=$?; return $rc; }; f",
  },
  { id: "B22", family: "exit codes", line: "(( $# > 0 )) || exit 1" },
  {
    id: "B24",
    family: "exit codes",
    line: "pytest; code=$?; if [ $code -eq 5 ]; then exit 0; fi; exit $code",
  },
];
