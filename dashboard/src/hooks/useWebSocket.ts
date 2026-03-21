import { useEffect, useRef } from 'react';

export interface WsMessage {
  type: 'mission-updated' | 'assignment-updated' | 'connected';
  missionSlug?: string;
  assignmentSlug?: string;
  timestamp: string;
}

type WsListener = (message: WsMessage) => void;

const listeners = new Set<WsListener>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(getWsUrl());

  ws.onmessage = (event) => {
    try {
      const message: WsMessage = JSON.parse(event.data);
      for (const listener of listeners) {
        listener(message);
      }
    } catch {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    ws = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

/**
 * Hook that subscribes to WebSocket messages.
 * Manages a single shared WebSocket connection for all components.
 */
export function useWebSocket(onMessage: WsListener): void {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;

  useEffect(() => {
    const listener: WsListener = (msg) => callbackRef.current(msg);
    listeners.add(listener);

    connect();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && ws) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        ws.close();
        ws = null;
      }
    };
  }, []);
}
