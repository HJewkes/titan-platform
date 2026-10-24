import type { CommonLine, RefusedLine } from "./common-lines.js";

/** Lines main allows in the "counters" family. */
export const countersLines: readonly CommonLine[] = [
  { id: "A02", family: "counters", line: "echo $(( $(wc -l < f) - $n ))" },
  { id: "A04", family: "counters", line: "echo $(( $(( a + 1 )) * $b ))" },
  { id: "A05", family: "counters", line: "x=$(( ${#s} * 2 ))" },
  {
    id: "A08",
    family: "counters",
    line: 'total=$(( total + $(wc -l < "$f") ))',
  },
  {
    id: "A09",
    family: "counters",
    line: "pct=$(( 100 * $(grep -c ok log) / $(wc -l < log) ))",
  },
  { id: "A10", family: "counters", line: "make -j$(( $(nproc) + 1 ))" },
  {
    id: "A11",
    family: "counters",
    line: "echo $(( $(git rev-list --count HEAD) + 1 ))",
  },
  { id: "A12", family: "counters", line: "kb=$(( $(stat -c %s f) / 1024 ))" },
  { id: "A14", family: "counters", line: "echo $(( ${#arr[@]} - 1 ))" },
  { id: "A15", family: "counters", line: "echo $(( ${x:-0} + 1 ))" },
  {
    id: "A16",
    family: "counters",
    line: "echo $(( $(git status --porcelain | wc -l) + 0 ))",
  },
  { id: "A17", family: "counters", line: "i=$(( i + 1 ))" },
  { id: "A18", family: "counters", line: "mid=$(( (lo + hi) / 2 ))" },
  { id: "A20", family: "counters", line: "echo $(( arr[$i] + 1 ))" },
  { id: "A22", family: "counters", line: "echo $(( `wc -l < f` * 2 ))" },
  {
    id: "A23",
    family: "counters",
    line: "n=$(( $(( x * 2 )) + $(( y * 3 )) ))",
  },
  { id: "F01", family: "counters", line: "echo $(( ${count:-0} + 1 ))" },
  {
    id: "F03",
    family: "counters",
    line: "echo $(( ${#files[@]} * $(nproc) ))",
  },
  { id: "F04", family: "counters", line: "echo $(( ${TIMEOUT:-30} * 1000 ))" },
  { id: "F07", family: "counters", line: "echo $(( 16#ff ))" },
  { id: "F10", family: "counters", line: "echo $(( 2**10 ))" },
  { id: "F11", family: "counters", line: "echo $(( x > 0 ? x : -x ))" },
  { id: "F14", family: "counters", line: "echo $(( $(ls | wc -l) - 1 ))" },
  { id: "F15", family: "counters", line: "printf '%d\\n' $(( $(id -u) + 0 ))" },
  { id: "F16", family: "counters", line: "echo $(( ${#line} > 80 ))" },
  { id: "F17", family: "counters", line: "echo $(( $(tput cols) / 2 ))" },
  {
    id: "F18",
    family: "counters",
    line: "echo $(( $(du -sk . | cut -f1) / 1024 ))MB",
  },
  {
    id: "B03",
    family: "counters",
    line: "for i in $(seq 1 3); do echo $((i*2)); done",
  },
  {
    id: "B05",
    family: "counters",
    line: 'arr=(a b c); for i in 0 1 2; do echo "${arr[$i]}"; done',
  },
  {
    id: "B06",
    family: "counters",
    line: "f() { local n=$1; echo $((n*2)); }; f 3",
  },
  { id: "B07", family: "counters", line: "echo $(( $a + $b ))" },
  {
    id: "B08",
    family: "counters",
    line: "for ((i=0; i<$n; i++)); do echo $i; done",
  },
  { id: "B09", family: "counters", line: "n=$(wc -l < f); echo $((n+1))" },
  {
    id: "B10",
    family: "counters",
    line: "i=0; while read -r l; do i=$((i+1)); done < f; echo $i",
  },
  {
    id: "B11",
    family: "counters",
    line: "count=$(grep -c foo f); if (( count > 0 )); then echo y; fi",
  },
  { id: "B12", family: "counters", line: "x=${1:-5}; echo $((x*2))" },
  {
    id: "B15",
    family: "counters",
    line: "lines=$(cat f | wc -l); echo $(( lines / 2 ))",
  },
  { id: "B17", family: "counters", line: "n=$(nproc); make -j$((n+1))" },
  { id: "B21", family: "counters", line: "shift $((OPTIND-1))" },
  {
    id: "B23",
    family: "counters",
    line: 'for f in *.log; do n=$(wc -l < "$f"); total=$((total+n)); done; echo $total',
  },
  { id: "B26", family: "counters", line: 'echo "${arr[$((i+1))]}"' },
  {
    id: "B27",
    family: "counters",
    line: "x=$(( $(git rev-list --count HEAD) % 10 ))",
  },
  { id: "B28", family: "counters", line: "n=$1; echo $((n*2))" },
  { id: "G03", family: "counters", line: "echo ${PATH:0:20}" },
  { id: "G04", family: "counters", line: "echo $(( COLUMNS / 2 ))" },
  { id: "G05", family: "counters", line: "echo $(( LINENO + 1 ))" },
  { id: "G06", family: "counters", line: "echo $(( PPID ))" },
  { id: "G07", family: "counters", line: "echo $(( ${#PWD} + 1 ))" },
  { id: "G08", family: "counters", line: "echo ${HOME:1}" },
  { id: "G09", family: "counters", line: "echo $(( OPTIND ))" },
  { id: "G10", family: "counters", line: "echo ${PWD##*/}" },
  { id: "G11", family: "counters", line: "s=abc; echo ${s:1:1}" },
  { id: "G13", family: "counters", line: "echo ${BASH_SOURCE[0]}" },
  { id: "G14", family: "counters", line: "echo ${FUNCNAME[0]}" },
  { id: "G15", family: "counters", line: "echo $(( UID == 0 ))" },
  { id: "G16", family: "counters", line: "x=abcdef; echo ${x:$((1+1)):2}" },
];

/**
 * "counters" lines main allowed that tool-guard now refuses: math over a file's contents. Call 1 can write
 * `commands[ls]=0` into the file and call 2 read it into math, and the guard cannot see across calls.
 */
export const countersRefused: readonly RefusedLine[] = [
  { id: "F09", family: "counters", line: "echo $(( $(cat count) + 1 ))", why: "file contents in math" },
  { id: "B18", family: "counters", line: "read -r n < count.txt; echo $((n+1))", why: "file contents in math" },
];
