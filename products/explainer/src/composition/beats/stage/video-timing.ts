// No imports: the CLI's script-time checks read these under plain node, and react-ui's motion entry pulls react-native into node (TP-4561).

/**
 * DIRECTION section 4 timing for video, which runs slower than titan-design's UI `MOTION` durations: a small move
 * takes 0.5 s and eases out, and an exit takes 0.85x its entrance. The spike's other video timings (standard and
 * camera moves, the capped stagger) arrive with the first ported beat that uses them.
 */
export const SMALL_MOVE_S = 0.5;
/** How long a flow token rests in each node it walks through. */
export const FLOW_DWELL_S = 0.8;
/** How long a flow node's lit state ramps in and out. */
export const LIT_RAMP_S = 0.2;
/** How long the hook's content takes to enter, and to leave at the end of its beat. */
export const HOOK_ENVELOPE_S = 0.3;
