import type { ReactNode } from 'react';

interface ErrorStateProps {
  title?: string;
  error: string;
  action?: ReactNode;
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  action,
}: ErrorStateProps) {
  return (
    <div className="rounded-lg border border-error-foreground/30 bg-error px-4 py-5">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-error-foreground">{title}</h3>
        <p className="text-sm leading-6 text-error-foreground/90">{error}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}
