export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatShortDateTime(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const totalSeconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (totalSeconds < 60) {
    return 'just now';
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h ago`;
  }

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ago`;
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function formatTokens(n: number): string {
  // Guarded because a field the type promises can still be missing at runtime:
  // the SPA and the server are deployed together but not restarted together, so
  // a browser holding a newer bundle can be talking to an older API. Without
  // this, one absent number threw inside render and blanked the whole page.
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

/**
 * Abbreviated token count for dense table cells — "1.4M", "38.2K", "912".
 *
 * The Agent Sessions table shows input and output side by side inside one
 * narrow column, where two grouped numbers ("1,041,407 / 2,812,110") do not
 * fit. Anywhere the exact figure matters — tooltips, detail panes — use
 * {@link formatTokens} instead.
 */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

export function formatCost(n: number): string {
  // Group thousands and show 2dp for readable amounts ($2,501.97); keep up to
  // 4dp for sub-dollar values so fractions of a cent aren't rounded to $0.00.
  if (!Number.isFinite(n)) return '$0.00';
  const maximumFractionDigits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  });
}

/**
 * Format a date-only `YYYY-MM-DD` string (e.g. usage `lastEventDay`) in the
 * local timezone. Unlike {@link formatDate}, this does NOT route through
 * `new Date(value)`, which parses a bare date as UTC midnight and renders the
 * previous calendar day in negative-offset zones. Returns an em-dash for
 * null/empty, and the raw value if it isn't a `YYYY-MM-DD` string.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDuration(started: string, ended?: string | null): string {
  const startDate = new Date(started);
  if (Number.isNaN(startDate.getTime())) {
    return '\u2014';
  }

  const endDate = ended ? new Date(ended) : new Date();
  if (Number.isNaN(endDate.getTime())) {
    return '\u2014';
  }

  const totalMinutes = Math.floor((endDate.getTime() - startDate.getTime()) / 60000);
  if (totalMinutes < 1) {
    return '< 1m';
  }

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60);
  if (days > 0) {
    const remainingHours = Math.floor((totalMinutes - days * 24 * 60) / 60);
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
