import { describe, expect, it, vi } from 'vitest';
import { authorizePtyUpgrade, type UpgradeRequestLike } from '../pty-upgrade-auth.js';

function req(url: string, ...addr: [string | undefined] | []): UpgradeRequestLike {
  const remoteAddress = addr.length === 0 ? '127.0.0.1' : addr[0];
  return { url, socket: { remoteAddress } };
}

/** A token registry that accepts `good` for `ab12` exactly once. */
function registry() {
  return {
    consume: vi.fn((token: string, short: string) => token === 'good' && short === 'ab12'),
  };
}

const PATH = '/ws/agent-sessions/ab12/pty';

describe('authorizePtyUpgrade', () => {
  it('accepts a loopback request with a valid token and parses dims', () => {
    const reg = registry();
    const r = authorizePtyUpgrade(req(`${PATH}?token=good&cols=120&rows=40`), { tokenRegistry: reg });
    expect(r).toEqual({ ok: true, short: 'ab12', cols: 120, rows: 40 });
    expect(reg.consume).toHaveBeenCalledWith('good', 'ab12');
  });

  it('falls back to default dims when query dims are absent or invalid', () => {
    const r1 = authorizePtyUpgrade(req(`${PATH}?token=good`), { tokenRegistry: registry() });
    expect(r1).toEqual({ ok: true, short: 'ab12', cols: 80, rows: 24 });
    const r2 = authorizePtyUpgrade(req(`${PATH}?token=good&cols=0&rows=-9`), { tokenRegistry: registry() });
    expect(r2).toEqual({ ok: true, short: 'ab12', cols: 80, rows: 24 });
  });

  it('rejects a non-loopback remote address WITHOUT consuming a token', () => {
    const reg = registry();
    for (const addr of ['192.168.1.5', '10.0.0.2', undefined]) {
      const r = authorizePtyUpgrade(req(`${PATH}?token=good`, addr), { tokenRegistry: reg });
      expect(r).toEqual({ ok: false, reason: 'not-loopback' });
    }
    expect(reg.consume).not.toHaveBeenCalled();
  });

  it('rejects a non-pty path without consuming a token', () => {
    const reg = registry();
    for (const p of ['/ws', '/ws/agent-sessions/ab12', '/ws/agent-sessions/ab12/pty/extra', '/api/x']) {
      expect(authorizePtyUpgrade(req(`${p}?token=good`), { tokenRegistry: reg })).toEqual({
        ok: false,
        reason: 'bad-path',
      });
    }
    expect(reg.consume).not.toHaveBeenCalled();
  });

  it('rejects when the token is missing', () => {
    expect(authorizePtyUpgrade(req(PATH), { tokenRegistry: registry() })).toEqual({
      ok: false,
      reason: 'no-token',
    });
  });

  it('rejects when the token is wrong/expired/for-another-short', () => {
    expect(authorizePtyUpgrade(req(`${PATH}?token=bad`), { tokenRegistry: registry() })).toEqual({
      ok: false,
      reason: 'bad-token',
    });
    // valid token but wrong short in the path
    expect(
      authorizePtyUpgrade(req('/ws/agent-sessions/zz99/pty?token=good'), { tokenRegistry: registry() }),
    ).toEqual({ ok: false, reason: 'bad-token' });
  });
});
