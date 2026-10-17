import type { CommonLine } from "./common-lines.js";

/** Lines main allows in the "dynamic script paths" family. */
export const scriptPathsLines: readonly CommonLine[] = [
  {
    id: "E02",
    family: "dynamic script paths",
    line: '"$(git rev-parse --show-toplevel)/scripts/build.sh"',
  },
  {
    id: "E03",
    family: "dynamic script paths",
    line: "$VIRTUAL_ENV/bin/python x.py",
  },
  {
    id: "E06",
    family: "dynamic script paths",
    line: '"$(dirname "$0")/run.sh"',
  },
  { id: "E07", family: "dynamic script paths", line: "$PWD/gradlew build" },
  { id: "E08", family: "dynamic script paths", line: '"$SCRIPT_DIR/setup.sh"' },
  {
    id: "E09",
    family: "dynamic script paths",
    line: 'export PATH="$GOPATH/bin:$PATH"; $GO test',
  },
  {
    id: "E10",
    family: "dynamic script paths",
    line: 'export PATH="$HOME/bin:$PATH"; "$EDITOR" f',
  },
  { id: "E12", family: "dynamic script paths", line: '"$(npm bin)/jest"' },
  {
    id: "E13",
    family: "dynamic script paths",
    line: 'cd "$(git rev-parse --show-toplevel)" && ./scripts/test.sh',
  },
  {
    id: "E14",
    family: "dynamic script paths",
    line: '"$CARGO_HOME/bin/cargo" fmt',
  },
];
