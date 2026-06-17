import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  error: string;
  action?: ReactNode;
  /**
   * When provided (and no custom `action` is given), renders a standard Retry
   * button that re-runs the failed load in place. Prefer this over a full page
   * reload so users recover from transient fetch failures without losing state.
   */
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  action,
  onRetry,
  retryLabel = 'Retry',
}: ErrorStateProps) {
  const resolvedAction =
    action ??
    (onRetry ? (
      <button type="button" onClick={onRetry} className="shell-action">
        <RotateCw className="h-4 w-4" />
        <span>{retryLabel}</span>
      </button>
    ) : null);

  return (
    <div className="rounded-lg border border-error-foreground/30 bg-error px-4 py-5">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-error-foreground">{title}</h3>
        <p className="text-sm leading-6 text-error-foreground/90">{error}</p>
        {resolvedAction ? <div className="pt-2">{resolvedAction}</div> : null}
      </div>
    </div>
  );
}
