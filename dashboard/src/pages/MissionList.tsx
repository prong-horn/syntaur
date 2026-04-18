import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useMissions, useWorkspacePrefix, type MissionSummary } from '../hooks/useMissions';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { FilterBar } from '../components/FilterBar';
import { SearchInput } from '../components/SearchInput';
import { ViewToggle } from '../components/ViewToggle';
import { SectionCard } from '../components/SectionCard';
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';
import { formatDate } from '../lib/format';
import { MISSION_BOARD_COLUMNS, moveItem } from '../lib/kanban';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

export function MissionList() {
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  const { data: missions, loading, error, refetch } = useMissions();
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:missions');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [archivedFilter, setArchivedFilter] = useState('active');
  const [tagFilter, setTagFilter] = useState('all');
  const [sortBy, setSortBy] = useState('updated');
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const view: 'cards' | 'table' | 'kanban' =
    viewParam === 'table' || viewParam === 'kanban' ? viewParam : 'cards';
  const setView = (v: 'cards' | 'table' | 'kanban') => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v === 'cards') {
        next.delete('view');
      } else {
        next.set('view', v);
      }
      return next;
    });
  };
  const [missionOrder, setMissionOrder] = useState<Record<string, string[]>>({});

  const filtered = useMemo(() => {
    if (!missions) {
      return [];
    }
    return missions
      .filter((mission) => {
        if (workspace) {
          if (workspace === '_ungrouped') {
            if (mission.workspace !== null) return false;
          } else {
            if (mission.workspace !== workspace) return false;
          }
        }
        if (archivedFilter === 'active' && mission.archived) {
          return false;
        }
        if (archivedFilter === 'archived' && !mission.archived) {
          return false;
        }
        if (statusFilter !== 'all' && mission.status !== statusFilter) {
          return false;
        }
        if (tagFilter !== 'all' && !mission.tags.includes(tagFilter)) {
          return false;
        }
        if (!search.trim()) {
          return true;
        }

        const haystack = `${mission.title} ${mission.tags.join(' ')} ${mission.slug}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      })
      .sort((left, right) => sortMissions(left, right, sortBy));
  }, [missions, search, statusFilter, archivedFilter, tagFilter, sortBy, workspace]);

  const filteredKey = filtered.map((mission) => `${mission.slug}:${mission.status}`).join('|');

  useEffect(() => {
    setMissionOrder(buildMissionColumnOrder(filtered));
  }, [filteredKey, sortBy]);

  const orderedBoardMissions = useMemo(() => {
    const bySlug = new Map(filtered.map((mission) => [mission.slug, mission]));

    return MISSION_BOARD_COLUMNS.flatMap((status) => {
      const orderedSlugs = missionOrder[status] ?? filtered
        .filter((mission) => mission.status === status)
        .map((mission) => mission.slug);

      return orderedSlugs
        .map((slug) => bySlug.get(slug))
        .filter((mission): mission is MissionSummary => Boolean(mission));
    });
  }, [filtered, missionOrder]);

  // Flat visible order: kanban traverses columns top-to-bottom, cards/table use `filtered`.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    const items = view === 'kanban' ? orderedBoardMissions : filtered;
    const byKey = new Map<string, number>();
    items.forEach((m, i) => byKey.set(m.slug, i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, filtered, orderedBoardMissions]);

  const { hotkeyRowProps } = useListSelection(visibleItems, {
    scope: 'list:missions',
    onOpen: (mission) => navigate(`${wsPrefix}/missions/${mission.slug}`),
  });
  useHotkey({
    keys: '/',
    scope: 'list:missions',
    description: 'Focus filter',
    handler: () => searchRef.current?.focus(),
  });
  useHotkey({
    keys: 'r',
    scope: 'list:missions',
    description: 'Refresh',
    handler: () => refetch(),
  });

  if (loading) {
    return <LoadingState label="Loading missions…" />;
  }

  if (error || !missions) {
    return <ErrorState error={error || 'Mission list is unavailable.'} />;
  }

  const tags = Array.from(new Set(missions.flatMap((mission) => mission.tags))).sort();

  return (
    <div className="space-y-5">
      <FilterBar>
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Search by mission title or tag"
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
          <option value="failed">Failed</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <select value={archivedFilter} onChange={(event) => setArchivedFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="active">Hide archived</option>
          <option value="all">All missions</option>
          <option value="archived">Archived only</option>
        </select>
        <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All tags</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="editor-input max-w-[180px]">
          <option value="updated">Sort: Updated</option>
          <option value="created">Sort: Created</option>
          <option value="title">Sort: Title</option>
          <option value="attention">Sort: Attention</option>
        </select>
        <ViewToggle
          value={view}
          onChange={(value) => setView(value as 'cards' | 'table' | 'kanban')}
          options={[
            { value: 'cards', label: 'Cards' },
            { value: 'table', label: 'Table' },
            { value: 'kanban', label: 'Kanban' },
          ]}
        />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          title={missions.length === 0 ? 'No missions yet' : 'No missions match these filters'}
          description={
            missions.length === 0
              ? 'A mission is the high-level objective that groups assignments, resources, and memories. Create one to start the dashboard flow.'
              : 'Adjust the current search and filters or create a new mission.'
          }
          actions={
            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/create/mission`}>
              Create Mission
            </Link>
          }
        />
      ) : view === 'cards' ? (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((mission, i) => (
            <Link
              key={mission.slug}
              to={`${wsPrefix}/missions/${mission.slug}`}
              className="block rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm transition hover:border-primary/40 hover:shadow-md"
              {...hotkeyRowProps(i)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">{mission.title}</h2>
                  <p className="text-sm text-muted-foreground">
                    Updated {formatDate(mission.updated)}
                  </p>
                </div>
                <StatusBadge status={mission.status} />
              </div>

              <div className="mt-4 space-y-3">
                <ProgressBar progress={mission.progress} showLegend />
                <div className="flex flex-wrap gap-2">
                  {mission.tags.map((tag) => (
                    <span key={tag} className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border border-border/60 bg-background/80 p-3">
                    <p className="text-muted-foreground">Needs attention</p>
                    <p className="mt-1 font-semibold text-foreground">
                      {mission.needsAttention.blockedCount + mission.needsAttention.failedCount}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/80 p-3">
                    <p className="text-muted-foreground">Assignments</p>
                    <p className="mt-1 font-semibold text-foreground">{mission.progress.total}</p>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : view === 'table' ? (
        <SectionCard title={`${filtered.length} mission${filtered.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="pb-3 font-medium">Mission</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Progress</th>
                  <th className="pb-3 font-medium">Attention</th>
                  <th className="pb-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((mission, i) => (
                  <tr
                    key={mission.slug}
                    className="border-b border-border/50 last:border-0"
                    {...hotkeyRowProps(i)}
                  >
                    <td className="py-4 pr-4">
                      <Link to={`${wsPrefix}/missions/${mission.slug}`} className="font-semibold text-foreground hover:text-primary">
                        {mission.title}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {mission.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <StatusBadge status={mission.status} />
                    </td>
                    <td className="py-4 pr-4">
                      <div className="min-w-[220px]">
                        <ProgressBar progress={mission.progress} />
                      </div>
                    </td>
                    <td className="py-4 pr-4 text-muted-foreground">
                      {mission.needsAttention.blockedCount + mission.needsAttention.failedCount}
                    </td>
                    <td className="py-4 text-muted-foreground">{formatDate(mission.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <KanbanBoard
          columns={MISSION_COLUMNS}
          items={orderedBoardMissions}
          getItemId={(mission) => mission.slug}
          getColumnId={(mission) => mission.status}
          canDrop={({ fromColumnId, toColumnId }) => ({
            allowed: true,
            reason:
              fromColumnId === toColumnId
                ? undefined
                : 'This will set a manual status override on the mission.',
          })}
          onMove={({ item, fromColumnId, toColumnId, fromIndex, toIndex }) => {
            if (fromColumnId === toColumnId) {
              const currentColumnOrder = missionOrder[fromColumnId] ?? filtered
                .filter((mission) => mission.status === fromColumnId)
                .map((mission) => mission.slug);

              setMissionOrder((current) => ({
                ...current,
                [fromColumnId]: moveItem(currentColumnOrder, fromIndex, toIndex),
              }));
              return;
            }

            fetch(`/api/missions/${item.slug}/status-override`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: toColumnId }),
            }).then(() => {
              window.location.reload();
            });
          }}
          emptyMessage={(column) => `No ${column.title.toLowerCase()} missions.`}
          renderCard={(mission, { dragging }) => {
            const flatIdx = visibleIndexByKey.get(mission.slug) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <MissionBoardCard mission={mission} dragging={dragging} />
              </div>
            );
          }}
        />
      )}

      <div className="rounded-lg border border-border/60 bg-card/80 p-3 text-sm text-muted-foreground">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4" />
          <p>
            Mission status is derived from assignment state by default.{view === 'kanban' ? ' Drag missions between columns or use' : ' Use'} the status override on the mission detail page to set a manual status.
          </p>
        </div>
      </div>
    </div>
  );
}

const MISSION_COLUMN_LABELS: Record<(typeof MISSION_BOARD_COLUMNS)[number], string> = {
  pending: 'Pending',
  active: 'Active',
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  archived: 'Archived',
};

const MISSION_COLUMNS: KanbanColumn[] = MISSION_BOARD_COLUMNS.map((status) => ({
  id: status,
  title: MISSION_COLUMN_LABELS[status],
  description: getStatusDescription(status),
}));

function sortMissions(left: MissionSummary, right: MissionSummary, sortBy: string): number {
  switch (sortBy) {
    case 'created':
      return right.created.localeCompare(left.created);
    case 'title':
      return left.title.localeCompare(right.title);
    case 'attention':
      return getAttentionScore(right) - getAttentionScore(left);
    case 'updated':
    default:
      return right.updated.localeCompare(left.updated);
  }
}

function getAttentionScore(mission: MissionSummary): number {
  return (
    mission.needsAttention.failedCount * 10 +
    mission.needsAttention.blockedCount * 5 +
    mission.needsAttention.unansweredQuestions
  );
}

function buildMissionColumnOrder(missions: MissionSummary[]): Record<string, string[]> {
  return Object.fromEntries(
    MISSION_BOARD_COLUMNS.map((status) => [
      status,
      missions
        .filter((mission) => mission.status === status)
        .map((mission) => mission.slug),
    ]),
  );
}

function MissionBoardCard({
  mission,
  dragging,
}: {
  mission: MissionSummary;
  dragging: boolean;
}) {
  const wsPrefix = useWorkspacePrefix();
  return (
    <div className="rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link to={`${wsPrefix}/missions/${mission.slug}`} className="text-base font-semibold text-foreground hover:text-primary">
            {mission.title}
          </Link>
          <p className="text-sm text-muted-foreground">Updated {formatDate(mission.updated)}</p>
        </div>
        <StatusBadge status={mission.status} />
      </div>

      <div className="mt-4">
        <ProgressBar progress={mission.progress} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {mission.tags.map((tag) => (
          <span key={tag} className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-foreground">
            {tag}
          </span>
        ))}
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {mission.progress.total} assignments
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {mission.needsAttention.blockedCount + mission.needsAttention.failedCount} needs attention
        </span>
      </div>

      <div className="mt-4 text-xs uppercase tracking-[0.08em] text-muted-foreground">
        {dragging ? 'Reordering within status' : 'Derived mission lane'}
      </div>
    </div>
  );
}
