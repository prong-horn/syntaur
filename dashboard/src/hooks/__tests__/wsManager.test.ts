import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWsManagerForTests,
  getConnectionStatus,
  setWsUrlResolver,
  subscribe,
  subscribeConnectionStatus,
  type ConnectionStatus,
} from '../wsManager';

// Minimal stand-in for the browser WebSocket. Records every instance the
// manager constructs and exposes the handler slots the manager assigns so the
// test can drive lifecycle events (e.g. simulate a network `onclose`).
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe('wsManager reconnect guard (B4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    setWsUrlResolver(() => 'ws://test.local/ws');
  });

  afterEach(() => {
    __resetWsManagerForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  });

  it('does NOT reconnect after the last subscriber unsubscribes', () => {
    const unsubscribe = subscribe(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Last (only) subscriber leaves → teardown closes intentionally.
    unsubscribe();

    // The intentional close fires onclose; it must not schedule a reconnect.
    const closedSocket = FakeWebSocket.instances[0];
    closedSocket.onclose?.();

    // Advance well past the reconnect delay.
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects on a genuine drop while a subscriber is still live', () => {
    subscribe(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Simulate a network drop (server-initiated close, not our teardown).
    FakeWebSocket.instances[0].onclose?.();

    // Reconnect is scheduled, not immediate.
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('wsManager connection status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    setWsUrlResolver(() => 'ws://test.local/ws');
  });

  afterEach(() => {
    __resetWsManagerForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  });

  it('emits connecting → open → reconnecting → open → closed across a full cycle', () => {
    const statuses: ConnectionStatus[] = [];
    // Subscribe before the first connect so we capture the initial "connecting".
    subscribeConnectionStatus((s) => statuses.push(s));
    expect(getConnectionStatus()).toBe('closed');

    const unsubscribe = subscribe(() => {});
    const socketA = FakeWebSocket.instances[0];
    socketA.onopen?.(); // dial succeeds
    socketA.onclose?.(); // genuine drop → reconnecting + schedule

    vi.advanceTimersByTime(2000); // reconnect timer fires → socket B
    const socketB = FakeWebSocket.instances[1];
    socketB.onopen?.(); // reconnect succeeds

    unsubscribe(); // last subscriber leaves → closed

    expect(statuses).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'open',
      'closed',
    ]);
  });

  it('ignores late events from a replaced socket (stale-socket guard)', () => {
    subscribe(() => {});
    const socketA = FakeWebSocket.instances[0];
    socketA.onopen?.();
    socketA.onclose?.(); // drop → reconnecting

    vi.advanceTimersByTime(2000); // socket B
    const socketB = FakeWebSocket.instances[1];
    socketB.onopen?.(); // now live on B
    expect(getConnectionStatus()).toBe('open');

    // Late handlers from the dead socket A must not disturb status or reconnect.
    socketA.onopen?.();
    socketA.onclose?.();
    vi.advanceTimersByTime(5000);

    expect(getConnectionStatus()).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(2); // no spurious third socket
  });

  it('goes to closed (not reconnecting) when torn down with a reconnect pending', () => {
    const unsubscribe = subscribe(() => {});
    const socketA = FakeWebSocket.instances[0];
    socketA.onopen?.();
    socketA.onclose?.(); // drop → reconnecting, timer scheduled
    expect(getConnectionStatus()).toBe('reconnecting');

    // Last subscriber leaves before the reconnect timer fires.
    unsubscribe();
    vi.advanceTimersByTime(5000);

    expect(getConnectionStatus()).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1); // reconnect was cancelled
  });
});
