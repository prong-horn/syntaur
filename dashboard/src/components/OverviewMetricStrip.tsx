import { Link } from 'react-router-dom';
import type { OverviewSegments } from '../hooks/useProjects';
import { useWorkspacePrefix } from '../hooks/useProjects';
import { SEGMENT_TITLE, type SegmentId } from '../lib/overviewCopy';

interface OverviewMetricStripProps {
  segments: OverviewSegments;
}

const SEGMENT_TO_FILTER: Record<SegmentId, string | null> = {
  readyForReview: '/assignments?status=review',
  readyToImplement: '/assignments?status=ready_to_implement',
  readyForPlanning: '/assignments?status=ready_for_planning',
  inProgress: '/assignments?status=in_progress',
  drafts: '/assignments?status=draft',
  blocked: '/assignments?status=blocked',
  newestCreated: '/assignments',
  stale: '/assignments?stale=1',
};

export function OverviewMetricStrip({ segments }: OverviewMetricStripProps) {
  const prefix = useWorkspacePrefix();
  const entries: Array<[SegmentId, number]> = [
    ['readyForReview', segments.readyForReview.total],
    ['readyToImplement', segments.readyToImplement.total],
    ['readyForPlanning', segments.readyForPlanning.total],
    ['inProgress', segments.inProgress.total],
    ['drafts', segments.drafts.total],
    ['blocked', segments.blocked.total],
    ['stale', segments.stale.total],
    ['newestCreated', segments.newestCreated.total],
  ];

  const nonZero = entries.filter(([, n]) => n > 0);
  const zero = entries.filter(([, n]) => n === 0);

  if (nonZero.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs">
      {nonZero.map(([id, total]) => (
        <Link
          key={id}
          to={`${prefix}${SEGMENT_TO_FILTER[id] ?? '/assignments'}`}
          className="rounded-md border border-border/60 bg-background px-2 py-1 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${SEGMENT_TITLE[id]}: ${total}`}
        >
          <span className="font-medium text-foreground">{total}</span>{' '}
          <span className="text-muted-foreground">{SEGMENT_TITLE[id]}</span>
        </Link>
      ))}
      {zero.length > 0 ? (
        <span
          className="rounded-md border border-dashed border-border/50 bg-background/40 px-2 py-1 text-muted-foreground"
          title={`Clean: ${zero.map(([id]) => SEGMENT_TITLE[id]).join(', ')}`}
        >
          +{zero.length} clean
        </span>
      ) : null}
    </div>
  );
}
