import type { CommonLine } from "./common-lines.js";

/** Lines main allows in the "timing" family. */
export const timingLines: readonly CommonLine[] = [
  { id: "A01", family: "timing", line: "elapsed=$(( $(date +%s) - $start ))" },
  { id: "A03", family: "timing", line: "echo $(( `date +%s` - $start ))" },
  {
    id: "A06",
    family: "timing",
    line: 'start=$(date +%s); make; echo "took $(( $(date +%s) - start ))s"',
  },
  {
    id: "A07",
    family: "timing",
    line: 'echo "$(( $(date +%s%N) / 1000000 ))"',
  },
  {
    id: "A13",
    family: "timing",
    line: "age=$(( $(date +%s) - $(stat -c %Y f) ))",
  },
  { id: "A19", family: "timing", line: "sleep $(( RANDOM % 5 ))" },
  {
    id: "A21",
    family: "timing",
    line: 'echo "elapsed: $(( ($(date +%s) - start) / 60 ))m"',
  },
  {
    id: "A24",
    family: "timing",
    line: "echo $(( $(date -d tomorrow +%s) - $(date +%s) ))",
  },
  {
    id: "F02",
    family: "timing",
    line: "echo $(( ${start:-0} - $(date +%s) ))",
  },
  {
    id: "F05",
    family: "timing",
    line: 'echo "$(( $(date +%s) - ${START:-0} ))"',
  },
  { id: "F06", family: "timing", line: "echo $(( 10#$(date +%H) + 1 ))" },
  { id: "F08", family: "timing", line: "echo $(( $(date +%-H) * 60 ))" },
  {
    id: "F12",
    family: "timing",
    line: "echo $(( $(date +%s) - $(date -r f +%s) ))",
  },
  {
    id: "F13",
    family: "timing",
    line: "echo $(( ($(date +%s%N) - t0) / 1000000 ))ms",
  },
  {
    id: "B13",
    family: "timing",
    line: "retries=0; until make check; do ((retries++)); (( retries > 3 )) && break; sleep 1; done",
  },
  {
    id: "B16",
    family: "timing",
    line: "start=$(date +%s); make; end=$(date +%s); echo $((end-start))",
  },
  {
    id: "G01",
    family: "timing",
    line: "t0=$SECONDS; make; echo $(( SECONDS - t0 ))",
  },
  { id: "G02", family: "timing", line: "echo $(( EPOCHSECONDS - 5 ))" },
  { id: "G12", family: "timing", line: "echo $(( $(date +%s) - SECONDS ))" },
];
