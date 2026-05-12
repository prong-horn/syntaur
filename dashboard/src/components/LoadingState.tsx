interface LoadingStateProps {
  label?: string;
}

export function LoadingState({
  label = 'Loading dashboard data…',
}: LoadingStateProps) {
  return (
    <div className="flex min-h-[240px] items-center justify-center">
      <div className="chrome-card !px-4 !py-3">
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
