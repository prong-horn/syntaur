// Pure (React-free) WebSocket connection manager.
//
// This module owns a single shared WebSocket connection plus its subscriber
// set, reconnect timer, and the "intentional close" guard. It is deliberately
// free of any React import so it can be unit-tested in the dashboard's node
// vitest environment (no DOM / no @testing-library) by stubbing
// `globalThis.WebSocket` and overriding the URL resolver.

export interface WsMessage {
  type:
    | 'project-updated'
    | 'assignment-updated'
    | 'servers-updated'
    | 'agent-sessions-updated'
    | 'playbooks-updated'
    | 'todos-updated'
    | 'leases-updated'
    | 'schedules-updated'
    | 'connected';
  projectSlug?: string;
  assignmentSlug?: string;
  timestamp: string;
}

export type WsListener = (message: WsMessage) => void;

const RECONNECT_DELAY_MS = 2000;

const listeners = new Set<WsListener>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Set true in teardown right before `ws.close()` so the resulting `onclose`
// does NOT schedule a reconnect for a close we asked for. Reset on connect.
let intentionalClose = false;

/**
 * Default URL resolver — reads `window.location`. Overridable via
 * {@link setWsUrlResolver} so node-based unit tests can run without a DOM.
 */
function defaultGetWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiPort = import.meta.env.DEV ? import.meta.env.VITE_API_PORT : undefined;

  if (apiPort && window.location.port !== apiPort) {
    return `${protocol}//${window.location.hostname}:${apiPort}/ws`;
  }

  return `${protocol}//${window.location.host}/ws`;
}

let getWsUrl: () => string = defaultGetWsUrl;

/**
 * Override the URL resolver (test seam). Pass no argument to restore the
 * default window-based resolver.
 */
export function setWsUrlResolver(resolver?: () => string): void {
  getWsUrl = resolver ?? defaultGetWsUrl;
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  intentionalClose = false;
  // Capture the instance so late async handlers from an OLD socket can't act on
  // a newer connection. Without the `ws !== socket` guards below, a stale
  // `onclose` firing after a resubscribe would null the live `ws` and schedule a
  // spurious reconnect, leaking sockets.
  const socket = new WebSocket(getWsUrl());
  ws = socket;

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    try {
      const message: WsMessage = JSON.parse(event.data);
      for (const listener of listeners) {
        listener(message);
      }
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return; // a newer connection already replaced us
    ws = null;
    // Do NOT reconnect for a close we initiated, or once every subscriber has
    // unmounted. A genuine drop with live subscribers still reconnects.
    if (intentionalClose || listeners.size === 0) {
      intentionalClose = false;
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket.close(); // close THIS socket, never a newer `ws`
  };
}

/**
 * Register a listener and ensure the shared connection is live. Returns an
 * unsubscribe function that tears the connection down once the last listener
 * leaves.
 */
export function subscribe(listener: WsListener): () => void {
  listeners.add(listener);
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        intentionalClose = true;
        ws.close();
        ws = null;
      }
    }
  };
}

/**
 * Test-only: reset all module state to its initial values. Not used by the app.
 */
export function __resetWsManagerForTests(): void {
  listeners.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws = null;
  intentionalClose = false;
  getWsUrl = defaultGetWsUrl;
}
