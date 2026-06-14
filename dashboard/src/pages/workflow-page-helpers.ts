// Pure helper for the WorkflowPage save bar. Summarizes per-tab validation
// problem counts into a single user-facing message plus the offending-tab
// breakdown. Statuses is intentionally excluded — status validation is
// server-side at save, not a client-side per-tab problem count.
export function tabProblemSummary(counts: {
  transitions: number;
  derive: number;
  facts: number;
}): {
  total: number;
  offending: Array<{ tab: string; count: number }>;
  message: string;
} {
  const offending: Array<{ tab: string; count: number }> = [];
  // Build in TAB ORDER: Transitions, then Derive Rules, then Facts.
  if (counts.transitions > 0) offending.push({ tab: 'Transitions', count: counts.transitions });
  if (counts.derive > 0) offending.push({ tab: 'Derive Rules', count: counts.derive });
  if (counts.facts > 0) offending.push({ tab: 'Facts', count: counts.facts });

  const total = counts.transitions + counts.derive + counts.facts;
  const message =
    total === 0
      ? 'Unsaved changes'
      : `Fix errors in ${offending.map((o) => o.tab).join(', ')} to save`;

  return { total, offending, message };
}
