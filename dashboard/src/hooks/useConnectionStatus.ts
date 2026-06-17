import { useSyncExternalStore } from 'react';
import {
  getConnectionStatus,
  subscribeConnectionStatus,
  type ConnectionStatus,
} from './wsManager';

/**
 * Reactively reflects the shared WebSocket connection status. Reflects state
 * only — it does not open or hold the connection (the app's message
 * subscribers own the socket lifecycle).
 */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    subscribeConnectionStatus,
    getConnectionStatus,
    getConnectionStatus,
  );
}
