import { useState, useCallback } from 'react';
import { useAgentSessions } from '../../../hooks/useProjects';
import {
  useSavedView,
  useDashboardLayout,
  setDashboardLayout,
  createSavedView,
} from '../../../hooks/useSavedViews';
import { RecentSessionsRail } from '../../RecentSessionsRail';
import { SessionViewResults } from './SessionViewResults';
import { SessionViewPicker } from '../../SessionViewPicker';
import { LoadingState } from '../../LoadingState';
import { CreateSessionViewDialog } from '../../CreateSessionViewDialog';
import { useToast } from '../../Toast';
import { buildSessionViewPayload } from '../../../lib/savedViews';
import type { CreateSessionViewBuilderState } from '../../../lib/savedViews';

interface AgentSessionsWidgetProps {
  viewId?: string;
  slotId?: string;
  onPickAnother?: () => void;
}

function MessageCard({
  title,
  message,
  onPickAnother,
}: {
  title: string;
  message: string;
  onPickAnother?: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      {onPickAnother ? (
        <button type="button" onClick={onPickAnother} className="shell-action mt-3">
          Pick another widget
        </button>
      ) : null}
    </div>
  );
}

export function AgentSessionsWidget({ viewId, slotId, onPickAnother }: AgentSessionsWidgetProps) {
  const { data, loading: sessionsLoading, error: sessionsError } = useAgentSessions();
  const { view, loading: viewLoading, ready } = useSavedView(viewId ?? null);
  const { layout } = useDashboardLayout();
  const { showToast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);

  const bindViewToSlot = useCallback(
    async (targetViewId: string | null) => {
      if (!slotId) return;
      const nextSlots = layout.slots.map((s) =>
        s.id === slotId
          ? {
              ...s,
              widget: targetViewId
                ? ({ kind: 'agent-sessions' as const, viewId: targetViewId })
                : ({ kind: 'agent-sessions' as const }),
            }
          : s,
      );
      try {
        await setDashboardLayout(nextSlots);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to update widget');
      }
    },
    [layout, slotId, showToast],
  );

  async function handleCreateFromWidget(name: string, state: CreateSessionViewBuilderState) {
    const { workspace, config } = buildSessionViewPayload(state, null);
    try {
      const file = await createSavedView({ name, workspace, config, entityType: 'session' });
      const created = file.views.find((v) => v.name === name && v.entityType === 'session');
      if (created) {
        await bindViewToSlot(created.id);
      }
      setCreateOpen(false);
      showToast(`Created session view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create session view');
      throw err;
    }
  }

  // Body depends on whether the slot is bound to a session view.
  let body: React.ReactNode;
  if (viewId) {
    if (viewLoading && !ready) {
      body = <LoadingState label="Loading view…" />;
    } else if (!view) {
      body = (
        <MessageCard
          title="View no longer exists"
          message="The saved view this widget was bound to has been deleted. Pick another session view above, or choose a different widget."
          onPickAnother={onPickAnother}
        />
      );
    } else if (view.entityType !== 'session') {
      body = (
        <MessageCard
          title="Wrong view type"
          message="This widget is bound to an assignment view. Choose a session view above, or pick a different widget."
          onPickAnother={onPickAnother}
        />
      );
    } else {
      body = (
        <SessionViewResults
          view={view}
          emptyDescription="Adjust the view's filters to surface different sessions, or pick another widget for this slot."
        />
      );
    }
  } else if (sessionsLoading && !data) {
    body = <LoadingState label="Loading sessions…" />;
  } else if (sessionsError) {
    body = (
      <MessageCard title="Couldn't load sessions" message={sessionsError} />
    );
  } else {
    body = <RecentSessionsRail sessions={data?.sessions ?? []} />;
  }

  return (
    <div className="space-y-2">
      {slotId ? (
        <div className="flex items-center justify-between gap-2">
          <SessionViewPicker
            activeViewId={viewId ?? null}
            onSelectView={(id) => void bindViewToSlot(id)}
            onCreateNew={() => setCreateOpen(true)}
          />
        </div>
      ) : null}
      {body}
      <CreateSessionViewDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspace={null}
        onSubmit={handleCreateFromWidget}
      />
    </div>
  );
}
