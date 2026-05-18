/**
 * Locked Overview copy. Single source of truth for hero, segment, and dialog strings.
 *
 * Both the backend (`api.ts` hero + reason emission) and the frontend
 * (`OverviewHero`, `OverviewSegment`, etc.) import from this module so copy
 * cannot drift between the API payload and what the UI renders.
 */

export type HeroCopyKey =
  | 'review'
  | 'review.singular'
  | 'ready_to_implement'
  | 'ready_to_implement.singular'
  | 'ready_for_planning'
  | 'ready_for_planning.singular'
  | 'in_progress'
  | 'in_progress.singular'
  | 'draft'
  | 'draft.singular'
  | 'blocked'
  | 'blocked.singular'
  | 'stale'
  | 'stale.singular'
  | 'clean';

/**
 * Hero strings. The `{total}` and `{title}` placeholders are substituted at
 * render time. Singular variants are used when `total === 1`.
 */
export const HERO_COPY: Record<HeroCopyKey, string> = {
  review: '{total} items ready for your review',
  'review.singular': 'Review {title}',
  ready_to_implement: '{total} plans ready to implement — start with {title}',
  'ready_to_implement.singular': 'Start implementing {title}',
  ready_for_planning: '{total} assignments ready to plan — start with {title}',
  'ready_for_planning.singular': 'Plan {title}',
  in_progress: 'Resume {title} ({total} in progress)',
  'in_progress.singular': 'Resume {title}',
  draft: 'Shape your {total} drafts — start with {title}',
  'draft.singular': 'Shape {title}',
  blocked: 'Unblock {title} ({total} blocked)',
  'blocked.singular': 'Unblock {title}',
  stale: 'Triage {total} stale items',
  'stale.singular': 'Triage {title} — sitting stale',
  clean: 'You’re all clear. Nothing needs you right now.',
};

export type SegmentId =
  | 'readyForReview'
  | 'readyToImplement'
  | 'readyForPlanning'
  | 'inProgress'
  | 'drafts'
  | 'blocked'
  | 'newestCreated'
  | 'stale';

/** Per-segment row reason (the one-liner under the title). */
export const SEGMENT_REASON: Record<SegmentId, string> = {
  readyForReview: 'Ready for your review',
  readyToImplement: 'Plan finalized — ready to implement',
  readyForPlanning: 'Ready to plan',
  inProgress: 'In progress',
  drafts: 'Draft — needs shape',
  blocked: 'Blocked',
  newestCreated: 'Newly created',
  stale: 'Sitting stale',
};

/** Per-segment empty state copy. */
export const SEGMENT_EMPTY: Record<SegmentId, string> = {
  readyForReview: 'No assignments waiting for your review.',
  readyToImplement: 'No plans queued for implementation.',
  readyForPlanning: 'No assignments waiting to be planned.',
  inProgress: 'Nothing actively in progress.',
  drafts: 'No drafts — ideas captured here will live until they’re shaped.',
  blocked: 'Nothing is blocked. Good.',
  newestCreated: 'No assignments created recently.',
  stale: 'No stale work — everything is fresh.',
};

/** Per-segment header titles. */
export const SEGMENT_TITLE: Record<SegmentId, string> = {
  readyForReview: 'Ready for Review',
  readyToImplement: 'Ready to Implement',
  readyForPlanning: 'Ready for Planning',
  inProgress: 'In Progress',
  drafts: 'Drafts',
  blocked: 'Blocked',
  newestCreated: 'Newest Created',
  stale: 'Stale',
};

/** Dialog + button copy used across Overview components. */
export const DIALOG_COPY = {
  claimAsTitle: 'Claim assignments as',
  claimAsHint: 'Used when you claim an assignment from this dashboard. You can change it later in settings.',
  claimAsSubmit: 'Save',
  claimAsRemember: 'Remember this choice',
  quickCommentTitle: 'Add a quick note',
  quickCommentPlaceholder: 'Note…',
  quickCommentSubmit: 'Post',
  bulkArchiveLabel: 'Archive selected',
  bulkClearLabel: 'Clear',
  bulkPartialFailureBanner: 'Some items failed to archive. The list has been refreshed.',
  emptyStateCleanTitle: 'You’re all clear',
  emptyStateCleanCTA: 'Browse projects',
  draftsHeaderCTA: 'Shape →',
  staleLoadMore: 'Load more',
  staleLoadMoreRemaining: '{remaining} remaining',
  recentSessionsEmptyTitle: 'No recent sessions',
  recentSessionsEmptyHint: 'Use /grab-assignment or `syntaur track-session` to register one.',
  recentSessionsCopyPathLabel: 'Copy path',
  recentSessionsCopyPathDisabled: 'Session has no path',
  recentSessionsCopyFallbackHint: 'Press ⌘C to copy',
} as const;

/** Substitute `{key}` placeholders in a template. */
export function formatCopy(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}
