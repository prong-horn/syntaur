import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWsManagerForTests,
  setWsUrlResolver,
  subscribe,
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
