import { useEffect, useMemo, useRef, useState } from 'react';
import { buildQueryRegistry } from '@shared/query-registry';
import { compileQuery } from '@shared/query';
import { getTemplateLabel, useTemplates } from '../hooks/useTemplates';
import { getStatusLabel, useStatusConfig } from '../hooks/useStatusConfig';
import { useArchived, useProject, useProjects, useTicketsBoard, type TicketBoardItem } from '../hooks/useProjects';
import { useBoardFilters } from '../hooks/useBoardFilters';
import { useBoardActions } from '../hooks/useBoardActions';
import { filterBoardItems } from '../lib/queryFilter';
import { filterTicketsByProjectSlugs } from '../lib/boardFilters';
import { filterByHistoryMode } from '../lib/boardHistory';
import { getTicketColumns } from '../lib/kanban';
import { sortTickets } from '../lib/sortTickets';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { Toaster, useToast } from '../components/Toast';
import { TicketTransitionDialog } from '../components/TicketTransitionDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BoardToolbar } from '../components/board/BoardToolbar';
import { BoardViews } from '../components/board/BoardViews';
import { BoardProjectPanel } from '../components/board/BoardProjectPanel';
import { BoardDialogs } from '../components/board/BoardDialogs';
import type { KanbanColumn } from '../components/KanbanBoard';
import type { TableColumnId } from '@shared/view-prefs-schema';

const UNKNOWN_TYPE = '__unknown_type__';

export function BoardPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  const { state, actions } = useBoardFilters();
  const { data, loading, error, refetch } = useTicketsBoard();
  const { data: projects, loading: projectsLoading, error: projectsError, refetch: refetchProjects } = useProjects();
  const { data: archived, loading: archivedLoading, refetch: refetchArchived } = useArchived();
  const focusSlug = state.project.length === 1 ? state.project[0] : undefined;
  const { data: projectDetail, loading: projectLoading, refetch: refetchProject } = useProject(focusSlug);
  const statusConfig = useStatusConfig();
  const templatesConfig = useTemplates();
  const { toast, showToast, dismissToast } = useToast();

  const [boardItems, setBoardItems] = useState<TicketBoardItem[]>([]);
  const [tableColumnVisibility, setTableColumnVisibility] = useState<{ hidden: TableColumnId[] }>({ hidden: [] });
  const [kanbanColumnVisibility, setKanbanColumnVisibility] = useState<{ hidden: string[] }>({ hidden: [] });

  useEffect(() => {
    setBoardItems(data?.tickets ?? []);
  }, [data]);

  const registry = useMemo(() => buildQueryRegistry(), []);
  const compiled = useMemo(() => {
    if (!state.query.trim()) return null;
    return compileQuery(state.query, registry).query;
  }, [registry, state.query]);

  const historyFiltered = useMemo(
    () => filterByHistoryMode(boardItems, state.history, state.olderThanDays),
    [boardItems, state.history, state.olderThanDays],
  );
  const projectFiltered = useMemo(
    () => filterTicketsByProjectSlugs(historyFiltered, state.project),
    [historyFiltered, state.project],
  );
  const filteredItems = useMemo(
    () => filterBoardItems(projectFiltered, compiled),
    [compiled, projectFiltered],
  );
  const sortedItems = useMemo(
    () => sortTickets(filteredItems, state.sortField, state.sortDirection),
    [filteredItems, state.sortField, state.sortDirection],
  );

  const columns = useMemo(() => getTicketColumns(statusConfig.order), [statusConfig]);
  const columnLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const id of columns) labels[id] = getStatusLabel(statusConfig, id);
    return labels;
  }, [columns, statusConfig]);

  const kanbanColumns: KanbanColumn[] = useMemo(
    () => columns.map((id) => ({ id, title: columnLabels[id] ?? id, description: '' })),
    [columns, columnLabels],
  );
  const typeKanbanColumns: KanbanColumn[] = useMemo(
    () =>
      templatesConfig.definitions.map((def) => ({
        id: def.id,
        title: getTemplateLabel(templatesConfig, def.id),
        description: def.description,
      })),
    [templatesConfig],
  );
  const knownTypeIds = useMemo(() => new Set(templatesConfig.definitions.map((d) => d.id)), [templatesConfig]);

  const listGroups = useMemo(() => {
    if (state.grouping === 'none') return [{ id: '__all__', label: 'All tickets', items: sortedItems }];
    if (state.grouping === 'status' || state.grouping === 'workflow') {
      return columns.map((status) => ({
        id: status,
        label: columnLabels[status] ?? status,
        items: sortedItems.filter((it) => it.status === status),
      }));
    }
    if (state.grouping === 'type') {
      const groups = templatesConfig.definitions.map((def) => ({
        id: def.id,
        label: getTemplateLabel(templatesConfig, def.id),
        items: sortedItems.filter((it) => it.template === def.id),
      }));
      const unknown = sortedItems.filter((it) => !it.template || !knownTypeIds.has(it.template));
      if (unknown.length) groups.push({ id: UNKNOWN_TYPE, label: 'Other', items: unknown });
      return groups;
    }
    return [{ id: '__all__', label: 'All tickets', items: sortedItems }];
  }, [columnLabels, columns, knownTypeIds, sortedItems, state.grouping, templatesConfig]);

  const boardActions = useBoardActions({
    boardItems,
    setBoardItems,
    refetch,
    statusConfig,
    showToast,
  });

  const filterOptions = useMemo(() => {
    const priorities = Array.from(new Set(boardItems.map((a) => a.priority))).sort();
    const assignees = Array.from(new Set(boardItems.map((a) => a.assignee ?? '__unassigned__'))).sort();
    const projectsMap = new Map<string, string>();
    for (const item of boardItems) {
      if (item.projectSlug) projectsMap.set(item.projectSlug, item.projectTitle ?? item.projectSlug);
    }
    const tags = Array.from(new Set(boardItems.flatMap((a) => a.tags ?? []))).sort();
    return {
      status: Array.from(new Set(boardItems.map((a) => a.status))).sort().map((s) => ({ value: s, label: columnLabels[s] ?? s })),
      priority: priorities.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })),
      template: templatesConfig.definitions.map((t) => ({ value: t.id, label: getTemplateLabel(templatesConfig, t.id) })),
      assignee: [
        { value: '__unassigned__', label: 'Unassigned' },
        ...assignees.filter((a) => a !== '__unassigned__').map((a) => ({ value: a, label: a })),
      ],
      project: Array.from(projectsMap.entries()).sort(([, a], [, b]) => a.localeCompare(b)).map(([slug, title]) => ({ value: slug, label: title })),
      tags: tags.map((t) => ({ value: t, label: t })),
    };
  }, [boardItems, columnLabels, templatesConfig]);

  function handleSort(field: typeof state.sortField) {
    if (state.sortField === field) {
      actions.setSortDirection(state.sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      actions.setSortField(field);
      actions.setSortDirection('asc');
    }
  }

  if (loading) return <LoadingState label="Loading board…" />;
  if (error || !data) return <ErrorState error={error || 'Board unavailable.'} onRetry={refetch} />;

  const showProjectPanel = Boolean(state.panel) || state.projectVisibility !== 'active' || state.project.length > 0;

  return (
    <div className="space-y-5" data-density={state.density} data-testid="board-page">
      <BoardToolbar
        state={state}
        actions={actions}
        searchRef={searchRef}
        registry={registry}
        statusOptions={filterOptions.status}
        priorityOptions={filterOptions.priority}
        templateOptions={filterOptions.template}
        assigneeOptions={filterOptions.assignee}
        projectOptions={filterOptions.project}
        tagOptions={filterOptions.tags}
        tableColumnVisibility={tableColumnVisibility}
        onTableColumnVisibilityChange={setTableColumnVisibility}
      />

      {showProjectPanel ? (
        <BoardProjectPanel
          state={state}
          actions={actions}
          projects={projects ?? undefined}
          archived={archived?.projects}
          projectDetail={projectDetail ?? undefined}
          projectsLoading={projectsLoading}
          archivedLoading={archivedLoading}
          projectLoading={projectLoading}
          projectsError={projectsError}
          onRefreshProjects={refetchProjects}
          onRefreshArchived={refetchArchived}
          onRefreshProject={refetchProject}
          showToast={showToast}
        />
      ) : null}

      <BoardViews
        state={state}
        items={boardItems}
        sortedItems={sortedItems}
        kanbanColumns={kanbanColumns}
        typeKanbanColumns={typeKanbanColumns}
        columnLabels={columnLabels}
        knownTypeIds={knownTypeIds}
        listGroups={listGroups}
        onMove={boardActions.handleMove}
        onRenameTitle={boardActions.handleRenameTitle}
        transitioningId={boardActions.transitioningId}
        onSort={handleSort}
        onClearFilters={actions.clearPrimaryFilters}
        tableColumnVisibility={tableColumnVisibility}
        kanbanColumnVisibility={kanbanColumnVisibility}
        onKanbanColumnVisibilityChange={setKanbanColumnVisibility}
      />

      <BoardDialogs state={state} actions={actions} showToast={showToast} />

      <TicketTransitionDialog
        open={boardActions.pendingMove !== null}
        action={boardActions.pendingMove?.action ?? null}
        ticketTitle={boardActions.pendingMove?.item.title ?? 'Ticket'}
        loading={boardActions.transitioningId === (boardActions.pendingMove ? boardActions.ticketKey(boardActions.pendingMove.item) : null)}
        onOpenChange={(open) => {
          if (!open) boardActions.setPendingMove(null);
        }}
        onConfirm={async (reason) => {
          if (!boardActions.pendingMove) return;
          const move = boardActions.pendingMove;
          const ok = await boardActions.applyMove({
            item: move.item,
            toColumnId: move.toColumnId,
            action: move.action,
            reason,
          });
          if (ok) boardActions.setPendingMove(null);
        }}
      />

      <ConfirmDialog
        open={boardActions.deleteTarget !== null}
        title="Delete ticket?"
        description={boardActions.deleteTarget ? `"${boardActions.deleteTarget.title}" will be permanently removed.` : ''}
        confirmLabel="Delete"
        destructive
        loading={boardActions.deletingKey !== null}
        onOpenChange={(next) => {
          if (!next && boardActions.deletingKey === null) boardActions.setDeleteTarget(null);
        }}
        onConfirm={boardActions.confirmDelete}
      />

      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
