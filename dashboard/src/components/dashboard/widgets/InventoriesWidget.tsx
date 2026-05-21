import { Link } from 'react-router-dom';
import { useInventories } from '../../../hooks/useProjects';
import { LoadingState } from '../../LoadingState';

const TOP_N = 5;

export function InventoriesWidget() {
  const { data, loading, error } = useInventories();

  if (loading && !data) {
    return <LoadingState label="Loading inventories…" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Couldn't load inventories</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }

  const inventories = data?.inventories ?? [];
  const top = inventories.slice(0, TOP_N);

  return (
    <aside
      aria-labelledby="overview-inventories-title"
      className="rounded-xl border border-border/60 bg-background/60 shadow-sm"
    >
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-3">
        <h3 id="overview-inventories-title" className="text-sm font-semibold text-foreground">
          Inventories
        </h3>
        <Link
          to="/inventories"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all →
        </Link>
      </header>
      {top.length === 0 ? (
        <div className="px-4 py-6 text-sm">
          <p className="font-medium text-foreground">No inventories yet.</p>
          <p className="mt-1 text-muted-foreground">
            Create one to track leased resources across agents.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {top.map((entry) => {
            const inv = entry.inventory;
            const activeCount = entry.active_leases.length;
            const memberCount = entry.members.length;
            const name = inv.display_name ?? inv.slug;
            return (
              <li key={inv.slug}>
                <Link
                  to={`/inventories/${encodeURIComponent(inv.slug)}`}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {activeCount}/{memberCount} leased
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
