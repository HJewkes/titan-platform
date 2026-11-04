import { describe, expect, it } from 'vitest';
import { procCommand } from './live-claude-sessions.js';

describe('procCommand', () => {
  it('names the executable from argv[0] of /proc/<pid>/cmdline, not the thread name', () => {
    const read = (file: string) => {
      expect(file).toBe('/proc/321/cmdline');
      return '/usr/bin/node\0/opt/claude/cli.js\0--resume\0';
    };

    expect(procCommand(321, read)).toBe('/usr/bin/node');
  });

  it('reports null when the cmdline is unreadable', () => {
    const unreadable = () => {
      throw new Error('ENOENT');
    };

    expect(procCommand(1, unreadable)).toBeNull();
  });

  it('reports null when the cmdline is empty', () => {
    expect(procCommand(1, () => '')).toBeNull();
  });
});
