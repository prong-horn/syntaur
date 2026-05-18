import { useCallback, useMemo, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import {
  useHelp,
  useOverview,
  type AttentionItem,
  type OverviewSegments,
} from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { GettingStartedCard } from '../components/GettingStartedCard';
import { OverviewHero } from '../components/OverviewHero';
import { OverviewSegment } from '../components/OverviewSegment';
import { OverviewMetricStrip } from '../components/OverviewMetricStrip';
import { BulkActionBar } from '../components/BulkActionBar';
import { RecentSessionsRail } from '../components/RecentSessionsRail';
import { OverviewFilterInput } from '../components/OverviewFilterInput';
import { ClaimAsDialog } from '../components/ClaimAsDialog';
import { QuickCommentDialog } from '../components/QuickCommentDialog';
import {
  claimAssignment,
  claimAssignmentById,
  hasStoredClaimAs,
  postQuickComment,
  readClaimAs,
  runBulkAssignmentAction,
  runAssignmentTransition,
  runAssignmentTransitionById,
} from '../lib/assignments';
import { useHotkey, useHotkeyScope } from '../hotkeys';

const STALE_PAGE_SIZE = 50;
const ARCHIVE_TARGET_STATUS = 'archived';

export function Overview() {
  const [staleOffset, setStaleOffset] = useState(0);
  const { data: overview, loading, error, refetch } = useOverview({
    staleLimit: STALE_PAGE_SIZE,
    staleOffset,
  });
  const { data: help } = useHelp();

  const [filterText, setFilterText] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  const [selectedStale, setSelectedStale] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkBanner, setBulkBanner] = useState<string | null>(null);

  const [claimAsOpen, setClaimAsOpen] = useState(false);
  const claimAsResolver = useRef<((value: string) => void) | null>(null);

  const [commentTarget, setCommentTarget] = useState<AttentionItem | null>(null);
  const [commentLoading, setCommentLoading] = useState(false);

  useHotkeyScope('list:overview');
  useHotkey({
    keys: '/',
    description: 'Focus filter',
    scope: 'list:overview',
    handler: (event) => {
      event.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
    },
  });
  useHotkey({
    keys: 'r',
    description: 'Refresh',
    scope: 'list:overview',
    handler: () => {
      void refetch();
    },
  });
  useHotkey({
    keys: 'Escape',
    description: 'Clear selection / filter',
    scope: 'list:overview',
    handler: () => {
      setSelectedStale(new Set());
      setFilterText('');
    },
  });

  const itemsById = useMemo(() => buildItemsIndex(overview?.segments), [overview?.segments]);

  const ensureClaimAs = useCallback(async (shiftKey: boolean): Promise<string | null> => {
    if (shiftKey || !hasStoredClaimAs()) {
      return new Promise<string | null>((resolve) => {
        claimAsResolver.current = (value) => {
          resolve(value);
        };
        setClaimAsOpen(true);
      });
    }
    return readClaimAs();
  }, []);

  const handleClaim = useCallback(
    async (item: AttentionItem, shiftKey = false) => {
      const assignee = await ensureClaimAs(shiftKey);
      if (!assignee) return;
      try {
        if (item.projectSlug) {
          await claimAssignment({
            projectSlug: item.projectSlug,
            assignmentSlug: item.assignmentSlug,
            assignee,
          });
        } else {
          await claimAssignmentById({ id: item.id.split(':')[1] ?? item.id, assignee });
        }
        await refetch();
      } catch (err) {
        console.error('Claim failed:', err);
      }
    },
    [ensureClaimAs, refetch],
  );

  const handleAdvance = useCallback(
    async (item: AttentionItem) => {
      const enabled = item.availableTransitions.filter((t) => !t.disabled);
      if (enabled.length === 0) return;
      const action = enabled[0];
      try {
        if (item.projectSlug) {
          await runAssignmentTransition(item.projectSlug, item.assignmentSlug, action);
        } else {
          const standaloneId = item.id.split(':')[1] ?? item.id;
          await runAssignmentTransitionById(standaloneId, action);
        }
        await refetch();
      } catch (err) {
        console.error('Advance failed:', err);
      }
    },
    [refetch],
  );

  const handleCommentSubmit = useCallback(
    async (body: string, type: 'note' | 'question' | 'feedback') => {
      if (!commentTarget) return;
      setCommentLoading(true);
      try {
        await postQuickComment({
          projectSlug: commentTarget.projectSlug,
          assignmentSlug: commentTarget.projectSlug ? commentTarget.assignmentSlug : undefined,
          id: commentTarget.projectSlug ? undefined : commentTarget.id.split(':')[1] ?? commentTarget.id,
          body,
          type,
        });
        setCommentTarget(null);
      } catch (err) {
        console.error('Comment failed:', err);
      } finally {
        setCommentLoading(false);
      }
    },
    [commentTarget],
  );

  const handleBulkArchive = useCallback(async () => {
    if (selectedStale.size === 0 || !overview) return;
    setBulkLoading(true);
    setBulkBanner(null);
    try {
      const items = overview.segments.stale.items
        .filter((item) => selectedStale.has(item.id))
        .map((item) => ({
          projectSlug: item.projectSlug,
          assignmentSlug: item.projectSlug ? item.assignmentSlug : undefined,
          id: item.projectSlug ? undefined : item.id.split(':')[1] ?? item.id,
          status: ARCHIVE_TARGET_STATUS,
        }));
      const result = await runBulkAssignmentAction(items, 'Bulk archive from Overview');
      if (result.failed > 0) {
        setBulkBanner(`${result.failed} of ${items.length} items failed. The list has been refreshed.`);
      }
      setSelectedStale(new Set());
      setStaleOffset(0);
      await refetch();
    } catch (err) {
      console.error('Bulk archive failed:', err);
      setBulkBanner((err as Error).message);
    } finally {
      setBulkLoading(false);
    }
  }, [overview, selectedStale, refetch]);

  const toggleStaleSelect = useCallback((id: string) => {
    setSelectedStale((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (loading && !overview) {
    return <LoadingState label="Loading overview…" />;
  }

  if (error || !overview) {
    return <ErrorState error={error || 'Overview data is unavailable.'} />;
  }

  const draftsCTA = overview.segments.drafts.items[0]
    ? {
        label: 'Shape →',
        href: overview.segments.drafts.items[0].projectSlug
          ? overview.segments.drafts.items[0].href
          : overview.segments.drafts.items[0].href,
      }
    : undefined;

  const staleFooter = overview.segments.stale.hasMore
    ? (
      <div className="flex justify-center px-4 py-3">
        <button
          type="button"
          onClick={() => setStaleOffset((o) => o + STALE_PAGE_SIZE)}
          className="shell-action"
        >
          Load more ({overview.segments.stale.total - overview.segments.stale.offset - overview.segments.stale.items.length} remaining)
        </button>
      </div>
    )
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Workspace Overview</p>
        <h1 className="text-4xl font-semibold tracking-display text-foreground md:text-5xl">
          What needs you today
        </h1>
      </header>

      <OverviewFilterInput
        ref={filterRef}
        value={filterText}
        onChange={setFilterText}
        onClear={() => setFilterText('')}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-4">
          <OverviewHero hero={overview.hero} itemsById={itemsById} />

          <OverviewSegment
            id="readyForReview"
            items={overview.segments.readyForReview.items}
            total={overview.segments.readyForReview.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="readyToImplement"
            items={overview.segments.readyToImplement.items}
            total={overview.segments.readyToImplement.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="readyForPlanning"
            items={overview.segments.readyForPlanning.items}
            total={overview.segments.readyForPlanning.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="inProgress"
            items={overview.segments.inProgress.items}
            total={overview.segments.inProgress.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="blocked"
            items={overview.segments.blocked.items}
            total={overview.segments.blocked.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="drafts"
            items={overview.segments.drafts.items}
            total={overview.segments.drafts.total}
            filterText={filterText}
            headerCTA={draftsCTA}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />
          <OverviewSegment
            id="stale"
            items={overview.segments.stale.items}
            total={overview.segments.stale.total}
            filterText={filterText}
            selectable
            selectedIds={selectedStale}
            onToggleSelect={toggleStaleSelect}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
            footer={staleFooter}
          />
          <OverviewSegment
            id="newestCreated"
            items={overview.segments.newestCreated.items}
            total={overview.segments.newestCreated.total}
            filterText={filterText}
            onClaim={(item) => handleClaim(item)}
            onAdvance={handleAdvance}
            onComment={(item) => setCommentTarget(item)}
          />

          <OverviewMetricStrip segments={overview.segments} />

          {overview.serverStats ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Monitor className="h-3 w-3" aria-hidden="true" />
              <span>
                ● {overview.serverStats.totalPorts} ports ·{' '}
                {overview.serverStats.deadSessions > 0
                  ? `${overview.serverStats.deadSessions} dead`
                  : 'all healthy'}
              </span>
            </p>
          ) : null}
        </div>

        <div className="space-y-4">
          <RecentSessionsRail sessions={overview.recentSessions} />
          {overview.firstRun ? <GettingStartedCard help={help} /> : null}
        </div>
      </div>

      <BulkActionBar
        count={selectedStale.size}
        loading={bulkLoading}
        partialFailureBanner={bulkBanner}
        onArchive={handleBulkArchive}
        onClear={() => setSelectedStale(new Set())}
      />

      <ClaimAsDialog
        open={claimAsOpen}
        onOpenChange={(next) => {
          if (!next && claimAsResolver.current) {
            // Cancelled — resolve null so caller bails.
            claimAsResolver.current(readClaimAs());
            claimAsResolver.current = null;
          }
          setClaimAsOpen(next);
        }}
        onSubmit={(assignee) => {
          if (claimAsResolver.current) {
            claimAsResolver.current(assignee);
            claimAsResolver.current = null;
          }
        }}
      />

      <QuickCommentDialog
        open={commentTarget !== null}
        assignmentTitle={commentTarget?.assignmentTitle ?? ''}
        loading={commentLoading}
        onSubmit={handleCommentSubmit}
        onOpenChange={(next) => {
          if (!next) setCommentTarget(null);
        }}
      />
    </div>
  );
}

function buildItemsIndex(segments: OverviewSegments | undefined): Record<string, AttentionItem> {
  if (!segments) return {};
  const result: Record<string, AttentionItem> = {};
  for (const key of Object.keys(segments) as Array<keyof OverviewSegments>) {
    const payload = segments[key];
    for (const item of payload.items) {
      result[item.id] = item;
    }
  }
  return result;
}
