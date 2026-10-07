import type { MaskRule } from '../masks.js';

/**
 * Generic fallback mask config, used for any tool type without a dedicated
 * frozen config. Callers can supply a dedicated per-partition config through
 * `ClustererOptions.masks`. Order matters: earlier rules run first, so their
 * replacement placeholders (`<UUID>`) never get re-matched by a later,
 * looser rule (`<NUM>`).
 */
const genericMaskConfig: MaskRule[] = [
  {
    name: 'UUID',
    pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    flags: 'gi',
  },
  // Lookaheads demand a hex letter and a digit, so epoch seconds and words like "defaced" fall through.
  {
    name: 'SHA',
    pattern: '\\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\\d)[0-9a-f]{7,40}\\b',
    flags: 'gi',
  },
  { name: 'PATH', pattern: '(?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]+', flags: 'g' },
  {
    name: 'DURATION',
    pattern: '\\b\\d+(?:\\.\\d+)?\\s?(?:ms|s|sec|seconds|min)\\b',
    flags: 'gi',
  },
  { name: 'LINENO', pattern: ':\\d+:\\d+\\b', flags: 'g' },
  {
    name: 'EXITCODE',
    pattern: '\\b(?:exit code|exit status)[: ]+\\d+\\b',
    flags: 'gi',
  },
  { name: 'NUM', pattern: '\\d+', flags: 'g' },
];

export default genericMaskConfig;
