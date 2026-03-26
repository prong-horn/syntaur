interface LoadingStateProps {
  label?: string;
}

export function LoadingState({
  label = 'Loading dashboard data…',
}: LoadingStateProps) {
  return (
    <div className="flex min-h-[240px] items-center justify-center">
      <div className="rounded-lg border border-border/70 bg-card/90 px-4 py-3 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
