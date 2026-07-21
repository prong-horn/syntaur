// Fixtures are literal NDJSON strings mirroring the spool's on-disk shape
// (Task 6/9: one `{event, at, payload}` object per line, payload = the
// hook's stdin dumped verbatim). Parsing them through `events()` — rather
// than hand-building HookEvent objects — is the AC7 "captured hook event
// streams" evidence: it proves the adapter reads what the spool actually
// writes, not an idealized shape.
import { describe, expect, it } from 'vitest';
import type { DeriveInput, HookEvent } from '../types.js';
import { claudeAdapter } from '../adapters/claude.js';
import { resolveAdapter } from '../adapters/registry.js';

const FIXED_NOW = 1_700_000_000_000;

/** Parse literal NDJSON into HookEvent[] — mirrors the spool tailer's contract. */
function events(ndjson: string): HookEvent[] {
  return ndjson
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as HookEvent);
}

function input(hookEvents: HookEvent[], lines: string[] = ['$ claude'], idle = 0): DeriveInput {
  return {
    screen: { lines, cols: 80, rows: 24 },
    hookEvents,
    procAlive: true,
    outputIdleMs: idle,
    cwd: '/w',
    nowMs: FIXED_NOW,
  };
}

// --- captured NDJSON lines (spool shape) --------------------------------

const PERMISSION_WITH_MESSAGE =
  '{"event":"Notification","at":"2026-07-19T00:00:00Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}}';

const PERMISSION_NO_MESSAGE =
  '{"event":"Notification","at":"2026-07-19T00:00:01Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"Notification","notification_type":"permission_prompt"}}';

const IDLE_PROMPT =
  '{"event":"Notification","at":"2026-07-19T00:00:02Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"Notification","notification_type":"idle_prompt"}}';

const AUTH_SUCCESS =
  '{"event":"Notification","at":"2026-07-19T00:00:03Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"Notification","notification_type":"auth_success"}}';

const PERMISSION_REQUEST_WITH_TOOL =
  '{"event":"PermissionRequest","at":"2026-07-19T00:00:04Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"PermissionRequest","tool_name":"Bash"}}';

const PERMISSION_REQUEST_NO_TOOL =
  '{"event":"PermissionRequest","at":"2026-07-19T00:00:05Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"PermissionRequest"}}';

const SESSION_START =
  '{"event":"SessionStart","at":"2026-07-19T00:00:06Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"SessionStart"}}';

const STOP =
  '{"event":"Stop","at":"2026-07-19T00:00:07Z","payload":{"session_id":"s1","transcript_path":"/t","cwd":"/w","hook_event_name":"Stop"}}';

const JUNK_PAYLOAD_STRING = '{"event":"Notification","at":"2026-07-19T00:00:08Z","payload":"oops"}';

const JUNK_PAYLOAD_MISSING = '{"event":"Notification","at":"2026-07-19T00:00:09Z"}';

const JUNK_NOTIFICATION_TYPE_NUMBER =
  '{"event":"Notification","at":"2026-07-19T00:00:10Z","payload":{"notification_type":42}}';

const UNKNOWN_EVENT = '{"event":"SubagentStart","at":"2026-07-19T00:00:11Z","payload":{"session_id":"s1"}}';

describe('claudeAdapter.deriveState', () => {
  it('(a) permission Notification WITH message -> blocked, needs the message', () => {
    const result = claudeAdapter.deriveState(input(events(PERMISSION_WITH_MESSAGE)));
    expect(result).toEqual({ state: 'blocked', needs: 'Claude needs your permission to use Bash' });
  });

  it('(b) permission Notification WITHOUT message -> blocked, needs "permission prompt"', () => {
    const result = claudeAdapter.deriveState(input(events(PERMISSION_NO_MESSAGE)));
    expect(result).toEqual({ state: 'blocked', needs: 'permission prompt' });
  });

  it('(c) idle_prompt Notification -> blocked, needs "waiting for input"', () => {
    const result = claudeAdapter.deriveState(input(events(IDLE_PROMPT)));
    expect(result).toEqual({ state: 'blocked', needs: 'waiting for input' });
  });

  it('(d) PermissionRequest WITH tool_name -> blocked, needs "permission: <tool>"', () => {
    const result = claudeAdapter.deriveState(input(events(PERMISSION_REQUEST_WITH_TOOL)));
    expect(result).toEqual({ state: 'blocked', needs: 'permission: Bash' });
  });

  it('(d) PermissionRequest WITHOUT tool_name -> blocked, needs "permission prompt"', () => {
    const result = claudeAdapter.deriveState(input(events(PERMISSION_REQUEST_NO_TOOL)));
    expect(result).toEqual({ state: 'blocked', needs: 'permission prompt' });
  });

  it('(e) permission -> answered -> working round-trip: full stream ending in Stop is working (Stop is latest)', () => {
    const stream = events([SESSION_START, PERMISSION_WITH_MESSAGE, STOP].join('\n'));
    expect(claudeAdapter.deriveState(input(stream))).toEqual({ state: 'working', needs: null });
  });

  it('(e) permission -> answered -> working round-trip: prefix before Stop is still blocked', () => {
    const prefix = events([SESSION_START, PERMISSION_WITH_MESSAGE].join('\n'));
    expect(claudeAdapter.deriveState(input(prefix))).toEqual({
      state: 'blocked',
      needs: 'Claude needs your permission to use Bash',
    });
  });

  it('(f) latest-wins ordering: a permission prompt arriving AFTER a Stop is blocked', () => {
    const stream = events([STOP, PERMISSION_WITH_MESSAGE].join('\n'));
    expect(claudeAdapter.deriveState(input(stream))).toEqual({
      state: 'blocked',
      needs: 'Claude needs your permission to use Bash',
    });
  });

  it('(g) a non-opinion event (auth_success) after a permission prompt does not clear it', () => {
    const stream = events([PERMISSION_WITH_MESSAGE, AUTH_SUCCESS].join('\n'));
    expect(claudeAdapter.deriveState(input(stream))).toEqual({
      state: 'blocked',
      needs: 'Claude needs your permission to use Bash',
    });
  });

  it('(h) payload as a bare string never throws; falls through to the screen fallback', () => {
    const stream = events(JUNK_PAYLOAD_STRING);
    expect(() => claudeAdapter.deriveState(input(stream))).not.toThrow();
    expect(claudeAdapter.deriveState(input(stream))).toEqual({ state: 'working', needs: null });
  });

  it('(h) missing payload never throws; falls through to the screen fallback', () => {
    const stream = events(JUNK_PAYLOAD_MISSING);
    expect(() => claudeAdapter.deriveState(input(stream))).not.toThrow();
    expect(claudeAdapter.deriveState(input(stream))).toEqual({ state: 'working', needs: null });
  });

  it('(h) notification_type as a number never throws; falls through to the screen fallback', () => {
    const stream = events(JUNK_NOTIFICATION_TYPE_NUMBER);
    expect(() => claudeAdapter.deriveState(input(stream))).not.toThrow();
    expect(claudeAdapter.deriveState(input(stream))).toEqual({ state: 'working', needs: null });
  });

  it('(h) a junk latest event never throws; falls through to an earlier real opinion', () => {
    const stream = events([PERMISSION_WITH_MESSAGE, JUNK_PAYLOAD_STRING].join('\n'));
    expect(() => claudeAdapter.deriveState(input(stream))).not.toThrow();
    expect(claudeAdapter.deriveState(input(stream))).toEqual({
      state: 'blocked',
      needs: 'Claude needs your permission to use Bash',
    });
  });

  it('(i) spool-silent: empty hookEvents delegates to the generic screen fallback (blocked)', () => {
    const result = claudeAdapter.deriveState(input([], ['Proceed? [y/N]'], 5000));
    expect(result).toEqual({ state: 'blocked', needs: 'confirm [y/N]' });
  });

  it('(i) spool-silent: empty hookEvents + normal screen delegates to working', () => {
    const result = claudeAdapter.deriveState(input([], ['just some output'], 0));
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it('unknown/future hook event types are ignored, not treated as a clear', () => {
    const stream = events([PERMISSION_WITH_MESSAGE, UNKNOWN_EVENT].join('\n'));
    expect(claudeAdapter.deriveState(input(stream))).toEqual({
      state: 'blocked',
      needs: 'Claude needs your permission to use Bash',
    });
  });

  it('is pure: same input twice yields identical results, no module state', () => {
    const x = input(events([SESSION_START, PERMISSION_WITH_MESSAGE].join('\n')));
    const first = claudeAdapter.deriveState(x);
    const second = claudeAdapter.deriveState(x);
    expect(first).toEqual(second);
    expect(claudeAdapter.deriveState(x)).toEqual(first);
  });

  it('registers under "claude" in the adapter registry', () => {
    expect(resolveAdapter('claude').id).toBe('claude');
  });
});
