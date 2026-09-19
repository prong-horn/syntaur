import { Link, useLocation } from 'react-router-dom';

/**
 * Catch-all for URLs no route claims. Without it the router renders nothing,
 * which reads as a broken dashboard rather than a wrong address.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        Nothing lives at <code className="font-mono">{pathname}</code>.
      </p>
      <Link
        to="/inbox"
        className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
      >
        Back to Needs me
      </Link>
    </div>
  );
}
