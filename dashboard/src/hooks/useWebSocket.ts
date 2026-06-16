import { useEffect, useRef } from 'react';
import { subscribe, type WsListener, type WsMessage } from './wsManager';

export type { WsMessage } from './wsManager';

/**
 * Hook that subscribes to WebSocket messages.
 * Manages a single shared WebSocket connection for all components via the
 * React-free connection manager in `wsManager.ts`.
 */
export function useWebSocket(onMessage: WsListener): void {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;

  useEffect(() => {
    const listener: WsListener = (msg: WsMessage) => callbackRef.current(msg);
    const unsubscribe = subscribe(listener);
    return unsubscribe;
  }, []);
}
