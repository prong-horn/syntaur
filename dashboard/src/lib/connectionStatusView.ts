// Pure presenter mapping a WebSocket connection status to what the shell
// indicator should display. React-free so it can be unit-tested in node-env
// vitest. The component decides styling from `tone`; this only decides
// visibility and copy.
import type { ConnectionStatus } from '../hooks/wsManager';

export interface ConnectionStatusView {
  /** Whether to show a visible pill. False keeps the indicator quiet. */
  show: boolean;
  label: string;
  tone: 'amber' | 'muted';
}

export function connectionStatusView(status: ConnectionStatus): ConnectionStatusView {
  switch (status) {
    case 'reconnecting':
      return { show: true, label: 'Reconnecting…', tone: 'amber' };
    case 'closed':
      return { show: true, label: 'Offline', tone: 'amber' };
    case 'connecting':
      return { show: true, label: 'Connecting…', tone: 'muted' };
    case 'open':
      // Live and healthy — stay quiet so the indicator is not a persistent
      // distraction.
      return { show: false, label: 'Live', tone: 'muted' };
  }
}
