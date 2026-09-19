import { ConfirmDialog } from '../ConfirmDialog';
import { TicketTransitionDialog } from '../TicketTransitionDialog';
import type { TicketTransitionAction } from '../../hooks/useProjects';

export interface TicketDialogsProps {
  ticketTitle: string;
  pendingTransition: TicketTransitionAction | null;
  transitioning: string | null;
  onPendingOpenChange: (open: boolean) => void;
  onConfirmTransition: (reason?: string) => Promise<void>;
  showDeleteConfirm: boolean;
  deleteLoading: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  onConfirmDelete: () => void;
}

export function TicketDialogs({
  ticketTitle,
  pendingTransition,
  transitioning,
  onPendingOpenChange,
  onConfirmTransition,
  showDeleteConfirm,
  deleteLoading,
  onDeleteOpenChange,
  onConfirmDelete,
}: TicketDialogsProps) {
  return (
    <>
      <TicketTransitionDialog
        open={pendingTransition !== null}
        action={pendingTransition}
        ticketTitle={ticketTitle}
        loading={transitioning === pendingTransition?.command}
        onOpenChange={onPendingOpenChange}
        onConfirm={onConfirmTransition}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete ticket?"
        description={`This will permanently delete "${ticketTitle}" and all its files (plan, scratchpad, journal, and any legacy record files). This cannot be undone.`}
        confirmLabel="Delete Ticket"
        destructive
        loading={deleteLoading}
        onOpenChange={onDeleteOpenChange}
        onConfirm={onConfirmDelete}
      />
    </>
  );
}
