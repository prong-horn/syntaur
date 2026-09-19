import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { TicketBoardItem, TicketTransitionAction } from '../data/types';
import { mutate } from '../data/mutate';
import { apiUrl, ticketWriteTargets } from '../data/resources';
import {
  dispatchVerbMessages,
  runTicketVerb,
  transitionNeedsReason,
  updateTicketTitle,
} from '../lib/tickets';
import { getStatusLabel } from './useStatusConfig';
import type { StatusConfigResponse } from './useStatusConfig';

export interface PendingTicketMove {
  item: TicketBoardItem;
  toColumnId: string;
  action: TicketTransitionAction;
}

function ticketKey(ticket: Pick<TicketBoardItem, 'id' | 'slug'>): string {
  return ticket.id || ticket.slug || 'unknown';
}

export function getTicketAction(
  ticket: TicketBoardItem,
  targetStatus: string,
): TicketTransitionAction | undefined {
  return ticket.availableVerbs.find((action) => action.targetStatus === targetStatus);
}

export function useBoardActions(options: {
  boardItems: TicketBoardItem[];
  setBoardItems: Dispatch<SetStateAction<TicketBoardItem[]>>;
  refetch: () => void;
  statusConfig: StatusConfigResponse;
  showToast: (message: string, kind: 'success' | 'error') => void;
}) {
  const { boardItems, setBoardItems, refetch, statusConfig, showToast } = options;
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingTicketMove | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TicketBoardItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const applyMove = useCallback(
    async ({
      item,
      toColumnId: _toColumnId,
      action,
      reason,
    }: {
      item: TicketBoardItem;
      toColumnId: string;
      action?: TicketTransitionAction;
      reason?: string;
    }) => {
      if (!action) {
        showToast('No verb reaches that stage from here.', 'error');
        return false;
      }

      const key = ticketKey(item);
      setTransitioningId(key);
      const previous = boardItems;
      setBoardItems((current) =>
        current.map((candidate) =>
          ticketKey(candidate) === key ? { ...candidate, status: action.targetStatus } : candidate,
        ),
      );

      try {
        const result = await runTicketVerb(item.id, action.command, { reason });
        for (const message of dispatchVerbMessages(result)) {
          showToast(message, 'error');
        }
        const updated = result.ticket;
        setBoardItems((current) =>
          current.map((candidate) =>
            ticketKey(candidate) === key
              ? {
                  ...candidate,
                  status: updated.status,
                  blocked: updated.blocked,
                  parked: updated.parked,
                  availableVerbs: updated.availableVerbs,
                  updated: updated.updated,
                }
              : candidate,
          ),
        );
        refetch();
        showToast(`Moved to ${getStatusLabel(statusConfig, updated.status)}`, 'success');
        return true;
      } catch (mutationError) {
        setBoardItems(previous);
        showToast((mutationError as Error).message, 'error');
        return false;
      } finally {
        setTransitioningId(null);
      }
    },
    [boardItems, refetch, setBoardItems, showToast, statusConfig],
  );

  const handleMove = useCallback(
    async ({
      item,
      toColumnId,
      action: providedAction,
    }: {
      item: TicketBoardItem;
      toColumnId: string;
      action?: TicketTransitionAction;
    }) => {
      if (item.status === toColumnId) return;
      const action = providedAction ?? getTicketAction(item, toColumnId);
      if (action?.disabled) {
        showToast(action.disabledReason || `Cannot move this ticket to ${toColumnId}.`, 'error');
        return;
      }
      if (action && transitionNeedsReason(action)) {
        setPendingMove({ item, toColumnId, action });
        return;
      }
      await applyMove({ item, toColumnId, action });
    },
    [applyMove, showToast],
  );

  const handleRenameTitle = useCallback(
    async (item: TicketBoardItem, newTitle: string) => {
      if (newTitle === item.title) return;
      const key = ticketKey(item);
      const previous = boardItems;
      setBoardItems((current) =>
        current.map((candidate) =>
          ticketKey(candidate) === key ? { ...candidate, title: newTitle } : candidate,
        ),
      );
      setTransitioningId(key);
      try {
        const updated = await updateTicketTitle({ id: item.id, title: newTitle });
        setBoardItems((current) =>
          current.map((candidate) =>
            ticketKey(candidate) === key
              ? { ...candidate, title: updated.title, updated: updated.updated }
              : candidate,
          ),
        );
        refetch();
      } catch (mutationError) {
        setBoardItems(previous);
        showToast((mutationError as Error).message, 'error');
        throw mutationError;
      } finally {
        setTransitioningId(null);
      }
    },
    [boardItems, refetch, setBoardItems, showToast],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const key = ticketKey(deleteTarget);
    setDeletingKey(key);
    try {
      await mutate('DELETE', apiUrl(['tickets', deleteTarget.id]), undefined, {
        invalidates: ticketWriteTargets(deleteTarget.id, deleteTarget.projectSlug),
      });
      setDeleteTarget(null);
      refetch();
      showToast('Ticket deleted', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete ticket', 'error');
    } finally {
      setDeletingKey(null);
    }
  }, [deleteTarget, refetch, showToast]);

  return {
    transitioningId,
    pendingMove,
    setPendingMove,
    deleteTarget,
    setDeleteTarget,
    deletingKey,
    applyMove,
    handleMove,
    handleRenameTitle,
    confirmDelete,
    ticketKey,
  };
}
