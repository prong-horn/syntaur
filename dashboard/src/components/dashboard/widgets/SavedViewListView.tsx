import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { formatDate } from '../../../lib/format';
import { useStatusConfig, getStatusLabel } from '../../../hooks/useStatusConfig';
import type { AssignmentBoardItem } from '../../../hooks/useProjects';
import type { SortField, SortDirection } from '@shared/view-prefs-schema';
import type { ListSectionVisibility } from '@shared/saved-views-schema';
// Shared sorter — single source of truth (parsed-epoch date sort, etc.).
import { sortAssignments } from '../../../lib/sortAssignments';

// Standalone items NEVER get a /w/<ws> prefix — no such route exists.
function buildAssignmentHref(item: AssignmentBoardItem): string {
  if (item.projectSlug === null) {
    return `/assignments/${item.id}`;
  }
  const prefix = item.projectWorkspace ? `/w/${item.projectWorkspace}` : '';
  return `${prefix}/projects/${item.projectSlug}/assignments/${item.slug}`;
}

interface SavedViewListViewProps {
  items: AssignmentBoardItem[];
  statusOrder: string[];
  sortField: SortField;
  sortDirection: SortDirection;
  listSectionVisibility: ListSectionVisibility;
  compact?: boolean;
}

export function SavedViewListView({
  items,
  statusOrder,
  sortField,
  sortDirection,
  listSectionVisibility,
  compact = false,
}: SavedViewListViewProps) {
  const statusConfig = useStatusConfig();
  // Per-mount local overrides for expand/collapse interactions inside the widget.
  // Resets to the prop value whenever `listSectionVisibility` changes so live edits
  // to the source view re-flow into this widget (Decision 3 — live reference).
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(
    () => new Set(listSectionVisibility.collapsed),
  );
  useEffect(() => {
    setLocalCollapsed(new Set(listSectionVisibility.collapsed));
  }, [listSectionVisibility]);

  const toggleStatus = (status: string) => {
    setLocalCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  return (
    <div className={cn('space-y-2', compact ? 'space-y-1.5' : 'space-y-3')}>
      {statusOrder.map((status) => {
        const sectionItems = sortAssignments(
          items.filter((item) => item.status === status),
          sortField,
          sortDirection,
        );
        if (sectionItems.length === 0) return null;
        const expanded = !localCollapsed.has(status);
        const label = getStatusLabel(statusConfig, status);
        return (
          <div
            key={status}
            className="rounded-lg border border-border/60 bg-card/90"
          >
            <button
              type="button"
              onClick={() => toggleStatus(status)}
              className={cn(
                'flex w-full items-center gap-2 text-left',
                compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm',
              )}
            >
              <ChevronDown
                className={cn(
                  'text-muted-foreground transition-transform',
                  compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
                  expanded ? '' : '-rotate-90',
                )}
              />
              <span className="font-semibold text-foreground">{label}</span>
              <span
                className={cn(
                  'rounded-full border border-border/60 text-muted-foreground',
                  compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
                )}
              >
                {sectionItems.length}
              </span>
            </button>
            {expanded && (
              <ul
                className={cn(
                  'divide-y divide-border/40 border-t border-border/40',
                  compact ? 'text-xs' : 'text-sm',
                )}
              >
                {sectionItems.map((item) => {
                  const href = buildAssignmentHref(item);
                  return (
                    <li key={`${item.projectSlug ?? 'standalone'}:${item.id}`}>
                      <Link
                        to={href}
                        className={cn(
                          'flex items-center gap-3 hover:bg-muted/40',
                          compact ? 'px-3 py-1.5' : 'px-4 py-2.5',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {item.title}
                        </span>
                        {item.projectTitle ? (
                          <span className="hidden truncate text-muted-foreground sm:inline">
                            {item.projectTitle}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-muted-foreground">
                          {formatDate(item.updated)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
