import { Link } from 'react-router-dom';
import { Inbox, ListTodo } from 'lucide-react';
import { useHelp, useOverview } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { GettingStartedCard } from '../components/GettingStartedCard';
import { OverviewHero } from '../components/OverviewHero';
import { useHotkeyScope } from '../hotkeys';

export function Overview() {
  useHotkeyScope('list:overview');
  const { data: overview, error, refetch } = useOverview();
  const { data: help } = useHelp();

  const itemsById: Record<string, import('../hooks/useProjects').AttentionItem> = {};
  if (overview) {
    for (const key of Object.keys(overview.segments) as Array<keyof typeof overview.segments>) {
      for (const item of overview.segments[key].items) {
        itemsById[item.id] = item;
      }
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Overview</p>
        <h1 className="text-4xl font-semibold tracking-display text-foreground md:text-5xl">
          What needs you today
        </h1>
      </header>

      {overview ? (
        <OverviewHero hero={overview.hero} itemsById={itemsById} />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <LoadingState label="Loading overview…" />
      )}

      {overview?.firstRun ? <GettingStartedCard help={help} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/inbox"
          className="group rounded-xl border border-border/60 bg-background/60 p-5 shadow-sm transition hover:border-border hover:bg-background"
        >
          <div className="flex items-center gap-3">
            <Inbox className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
            <span className="text-lg font-medium text-foreground">Needs me</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Assignments and reviews waiting on you.</p>
        </Link>
        <Link
          to="/assignments"
          className="group rounded-xl border border-border/60 bg-background/60 p-5 shadow-sm transition hover:border-border hover:bg-background"
        >
          <div className="flex items-center gap-3">
            <ListTodo className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
            <span className="text-lg font-medium text-foreground">Board</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Kanban and table views across all assignments.</p>
        </Link>
      </div>
    </div>
  );
}
