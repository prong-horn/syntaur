// Real-ws integration for the pty upgrade wiring (Phase D, AC6). Boots a minimal
// http.Server wired exactly like createDashboardServer's upgrade handler — the
// token+loopback guard, the second noServer ws, and the bridge — with a fake
// upstream, and drives a genuine `ws` client against 127.0.0.1. Proves the
// success path (valid token → snapshot), that the existing /ws JSON channel
// still connects, and that bad-token / stopping upgrades are rejected. (A real
// client always presents 127.0.0.1, so the non-loopback reject is covered by the
// pty-upgrade-auth unit test.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createPtyBridge,
  MAX_WS_PAYLOAD_BYTES,
  type BridgeUpstream,
  type BridgeWs,
  type PtyBridge,
} from '../pty-bridge.js';
import { createPtyTokenRegistry, type PtyTokenRegistry } from '../pty-token.js';
import { authorizePtyUpgrade } from '../pty-upgrade-auth.js';
import { encodeFrame } from '../../daemon/protocol.js';
import type { AttachReply } from '../../daemon/types.js';

/** Fake daemon pty socket: 'connect' asynchronously, then reply to the attach
 * frame with a snapshot. */
class FakeUpstream extends EventEmitter {
  write(data: string): boolean {
    if (data.includes('"t":"attach"')) {
      queueMicrotask(() =>
        this.emit('data', Buffer.from(encodeFrame({ t: 'snapshot', data: 'RESTORED', cols: 80, rows: 24 }))),
      );
    }
    return true;
  }
  pause(): void {}
  resume(): void {}
  destroy(): void {
    this.emit('close');
  }
}

let server: Server;
let tokens: PtyTokenRegistry;
let bridge: PtyBridge;
let base: string;

beforeEach(async () => {
  tokens = createPtyTokenRegistry();
  bridge = createPtyBridge({
    attachOp: async () => ({ ok: true, ptySock: '/fake', rvSock: '/fake-rv', pid: 1 }) as AttachReply,
    connectPty: () => {
      const u = new FakeUpstream();
      queueMicrotask(() => u.emit('connect'));
      return u as unknown as BridgeUpstream;
    },
  });
  const jsonWss = new WebSocketServer({ noServer: true });
  jsonWss.on('connection', (ws) => ws.send('{"type":"connected"}'));
  const ptyWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  server = createServer();
  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === '/ws') {
      jsonWss.handleUpgrade(request, socket, head, (ws) => jsonWss.emit('connection', ws, request));
      return;
    }
    if (path.startsWith('/ws/agent-sessions/') && path.endsWith('/pty')) {
      if (bridge.isStopping()) {
        socket.destroy();
        return;
      }
      const auth = authorizePtyUpgrade(request, { tokenRegistry: tokens });
      if (!auth.ok) {
        socket.destroy();
        return;
      }
      ptyWss.handleUpgrade(request, socket, head, (ws) =>
        bridge.handleConnection(ws as unknown as BridgeWs, { short: auth.short, cols: auth.cols, rows: auth.rows }),
      );
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  bridge.stop();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Open a client; resolve its first message, or that the upgrade was rejected. */
function connect(url: string): Promise<{ firstMessage?: string; rejected: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const settle = (r: { firstMessage?: string; rejected: boolean }): void => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    ws.on('message', (d) => settle({ firstMessage: d.toString(), rejected: false }));
    ws.on('error', () => settle({ rejected: true }));
    ws.on('unexpected-response', () => settle({ rejected: true }));
    ws.on('close', () => settle({ rejected: true }));
  });
}

describe('pty upgrade integration (real ws)', () => {
  it('a valid loopback token upgrades and receives the restored snapshot', async () => {
    const { token, short } = tokens.mint('ab12');
    const res = await connect(`${base}/ws/agent-sessions/${short}/pty?token=${token}&cols=80&rows=24`);
    expect(res.rejected).toBe(false);
    expect(JSON.parse(res.firstMessage!)).toEqual({ t: 'snapshot', data: 'RESTORED', cols: 80, rows: 24 });
  });

  it('the existing /ws JSON channel still connects', async () => {
    const res = await connect(`${base}/ws`);
    expect(res.rejected).toBe(false);
    expect(JSON.parse(res.firstMessage!)).toEqual({ type: 'connected' });
  });

  it('rejects an upgrade with a bad token', async () => {
    const res = await connect(`${base}/ws/agent-sessions/ab12/pty?token=nope`);
    expect(res.rejected).toBe(true);
  });

  it('rejects an upgrade while the bridge is stopping', async () => {
    const { token, short } = tokens.mint('ab12');
    bridge.stop();
    const res = await connect(`${base}/ws/agent-sessions/${short}/pty?token=${token}`);
    expect(res.rejected).toBe(true);
  });
});
