import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { connectionStatusView } from '../lib/connectionStatusView';

/**
 * Compact live-connection indicator for the app shell. The `role="status"`
 * region is always mounted so changes are announced; it stays visually and
 * audibly quiet while the connection is healthy and only surfaces a pill when
 * the socket is connecting, reconnecting, or offline.
 */
export function ConnectionStatusIndicator() {
  const status = useConnectionStatus();
  const view = connectionStatusView(status);

  return (
    <div role="status" aria-live="polite" className="flex items-center">
      {view.show ? (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
            view.tone === 'amber'
              ? 'border-warning-foreground/30 bg-warning text-warning-foreground'
              : 'border-border/70 bg-background/80 text-muted-foreground'
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              view.tone === 'amber'
                ? 'bg-warning-foreground animate-pulse'
                : 'bg-muted-foreground/60'
            }`}
          />
          {view.label}
        </span>
      ) : (
        // Keep the live region mounted but empty so it stays quiet when live.
        <span className="sr-only" />
      )}
    </div>
  );
}
