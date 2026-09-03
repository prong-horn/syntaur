import { describe, it, expect } from 'vitest';
import { continuationUrl } from '../../dashboard/src/lib/recreate-flow';

describe('continuationUrl', () => {
  it('builds an assignment deep link with no mode', () => {
    expect(continuationUrl({ kind: 'assignment', id: 'abc 123' })).toBe(
      'syntaur://open?assignment=abc%20123',
    );
  });

  it('preserves mode=resume for a session', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'resume')).toBe(
      'syntaur://open?session=s1&mode=resume',
    );
  });

  it('preserves mode=fork for a session (does not collapse to resume)', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'fork')).toBe(
      'syntaur://open?session=s1&mode=fork',
    );
  });

  it('appends a fallback terminal override', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'fork', 'kitty')).toBe(
      'syntaur://open?session=s1&mode=fork&terminal=kitty',
    );
    // Assignment + fallback (no mode).
    expect(continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, 'wezterm')).toBe(
      'syntaur://open?assignment=a1&terminal=wezterm',
    );
  });

  it('appends &agent= for an assignment target (url-encoded)', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, 'claude e2e'),
    ).toBe('syntaur://open?assignment=a1&agent=claude%20e2e');
  });

  it('appends &agent= alongside a fallback terminal', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, 'wezterm', 'codex'),
    ).toBe('syntaur://open?assignment=a1&terminal=wezterm&agent=codex');
  });

  it('does NOT append agent for a session target (agent is pinned by the record)', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'resume', undefined, 'codex')).toBe(
      'syntaur://open?session=s1&mode=resume',
    );
  });

  it('omits agent when no agentId is given', () => {
    expect(continuationUrl({ kind: 'assignment', id: 'a1' })).toBe(
      'syntaur://open?assignment=a1',
    );
  });

  it('appends &prompt= for an assignment (url-encoded), alongside agent', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, 'claude', '@assignment go'),
    ).toBe('syntaur://open?assignment=a1&agent=claude&prompt=%40assignment%20go');
  });

  it('emits an empty &prompt= (presence-significant clear)', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, undefined, ''),
    ).toBe('syntaur://open?assignment=a1&prompt=');
  });

  it('omits prompt when undefined', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, undefined, undefined),
    ).toBe('syntaur://open?assignment=a1');
  });

  it('does NOT append prompt for a session target', () => {
    expect(
      continuationUrl({ kind: 'session', id: 's1' }, 'resume', undefined, undefined, '@assignment go'),
    ).toBe('syntaur://open?session=s1&mode=resume');
  });

  it('emits a standalone deep link from the agent id', () => {
    expect(continuationUrl({ kind: 'standalone', id: 'pi-jobs' })).toBe(
      'syntaur://open?standalone=pi-jobs',
    );
  });

  it('appends &prompt= for a standalone target', () => {
    expect(
      continuationUrl({ kind: 'standalone', id: 'pi-jobs' }, undefined, undefined, undefined, 'apply to 5'),
    ).toBe('syntaur://open?standalone=pi-jobs&prompt=apply%20to%205');
  });

  it('appends &agentName= for an assignment (url-encoded)', () => {
    expect(
      continuationUrl(
        { kind: 'assignment', id: 'a1' },
        undefined,
        undefined,
        'claude',
        undefined,
        'job applier',
      ),
    ).toBe('syntaur://open?assignment=a1&agent=claude&agentName=job%20applier');
  });

  it('does NOT append agentName for a standalone target', () => {
    expect(
      continuationUrl(
        { kind: 'standalone', id: 'pi-jobs' },
        undefined,
        undefined,
        undefined,
        undefined,
        'job-applier',
      ),
    ).toBe('syntaur://open?standalone=pi-jobs');
  });
});
