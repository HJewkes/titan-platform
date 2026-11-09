import { describe, expect, it } from 'vitest';

describe('test host zone', () => {
  it('runs a worker-thread test in UTC whatever zone the host uses', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const midnightHour = new Date(0).getHours();

    expect(zone).toBe('UTC');
    expect(midnightHour).toBe(0);
  });
});
