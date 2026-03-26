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
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-5 dark:border-rose-900 dark:bg-rose-950/30">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-rose-800 dark:text-rose-200">{title}</h3>
        <p className="text-sm leading-6 text-rose-700 dark:text-rose-300">{error}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}
