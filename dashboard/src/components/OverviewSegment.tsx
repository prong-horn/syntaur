import { Link } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import { OverflowMenu } from './OverflowMenu';
import type { AttentionItem, OverviewSegmentId, useWorkspacePrefix as _ } from '../hooks/useProjects';
import { useWorkspacePrefix } from '../hooks/useProjects';
import { formatRelativeTime } from '../lib/format';
import { SEGMENT_EMPTY, SEGMENT_TITLE } from '../lib/overviewCopy';

interface OverviewSegmentProps {
  id: OverviewSegmentId;
  items: AttentionItem[];
  total: number;
  filterText?: string;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onClaim?: (item: AttentionItem) => void;
  onAdvance?: (item: AttentionItem) => void;
  onComment?: (item: AttentionItem) => void;
  /** Optional CTA rendered in the segment header (used by Drafts). */
  headerCTA?: { label: string; href: string };
  /** Optional footer node (e.g., "Load more" for stale). */
  footer?: React.ReactNode;
}

export function OverviewSegment({
  id,
  items,
  total,
  filterText = '',
  selectable = false,
  selectedIds,
  onToggleSelect,
  onClaim,
  onAdvance,
  onComment,
  headerCTA,
  footer,
}: OverviewSegmentProps) {
  const prefix = useWorkspacePrefix();
  const trimmed = filterText.trim().toLowerCase();
  const filtered = trimmed
    ? items.filter((it) =>
        it.assignmentTitle.toLowerCase().includes(trimmed)
        || it.assignmentSlug.toLowerCase().includes(trimmed))
    : items;

  return (
    <section
      role="region"
      aria-labelledby={`overview-seg-${id}`}
      className="rounded-xl border border-border/60 bg-background/60 shadow-sm"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 id={`overview-seg-${id}`} className="text-sm font-semibold text-foreground">
            {SEGMENT_TITLE[id]}
          </h3>
          {total > 0 ? (
            <span className="text-xs text-muted-foreground">
              {total > items.length ? `${total} (showing ${items.length})` : total}
            </span>
          ) : null}
        </div>
        {headerCTA ? (
          <Link
            to={headerCTA.href}
            className="text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            {headerCTA.label}
          </Link>
        ) : null}
      </header>

      <div className="divide-y divide-border/40">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {trimmed ? 'No matches.' : SEGMENT_EMPTY[id]}
          </p>
        ) : (
          filtered.map((item) => (
            <SegmentRow
              key={item.id}
              item={item}
              prefix={prefix}
              selectable={selectable}
              selected={selectedIds?.has(item.id) ?? false}
              onToggleSelect={onToggleSelect}
              onClaim={onClaim}
              onAdvance={onAdvance}
              onComment={onComment}
            />
          ))
        )}
      </div>

      {footer}
    </section>
  );
}

interface SegmentRowProps {
  item: AttentionItem;
  prefix: string;
  selectable: boolean;
  selected: boolean;
  onToggleSelect?: (id: string) => void;
  onClaim?: (item: AttentionItem) => void;
  onAdvance?: (item: AttentionItem) => void;
  onComment?: (item: AttentionItem) => void;
}

const OVERVIEW_ADVANCE_PRECEDENCE = [
  'complete',
  'review',
  'implement',
  'plan-ready',
  'shape',
  'start',
  'unblock',
  'reopen',
];

function SegmentRow({
  item,
  prefix,
  selectable,
  selected,
  onToggleSelect,
  onClaim,
  onAdvance,
  onComment,
}: SegmentRowProps) {
  const href = item.projectSlug ? `${prefix}${item.href}` : item.href;
  const advance = pickAdvance(item);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {selectable ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect?.(item.id)}
          className="mt-1 h-4 w-4 cursor-pointer accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Select ${item.assignmentTitle}`}
        />
      ) : null}

      <Link
        to={href}
        className="min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{item.assignmentTitle}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.projectTitle ?? 'Standalone'}
              {item.assignee ? <> · <span className="text-foreground/80">{item.assignee}</span></> : null}
            </p>
          </div>
          <StatusBadge status={item.status} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{item.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground/80">
          {formatRelativeTime(item.updated)}
        </p>
      </Link>

      <OverflowMenu
        items={[
          {
            key: 'claim',
            label: 'Claim',
            onSelect: () => onClaim?.(item),
            disabled: !onClaim,
          },
          {
            key: 'advance',
            label: advance ? `Advance → ${advance.label}` : 'Advance',
            onSelect: advance ? () => onAdvance?.(item) : undefined,
            disabled: !advance,
            disabledReason: advance ? undefined : 'No transition available',
          },
          {
            key: 'comment',
            label: 'Comment',
            onSelect: () => onComment?.(item),
            disabled: !onComment,
          },
          {
            key: 'open',
            label: 'Open',
            href,
          },
        ]}
      />
    </div>
  );
}

function pickAdvance(item: AttentionItem) {
  const enabled = item.availableTransitions.filter((t) => !t.disabled);
  for (const command of OVERVIEW_ADVANCE_PRECEDENCE) {
    const match = enabled.find((t) => t.command === command);
    if (match) return match;
  }
  return enabled[0] ?? null;
}
