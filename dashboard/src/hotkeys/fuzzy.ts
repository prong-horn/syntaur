// Hand-rolled subsequence fuzzy ranker (R5c).
// Scoring per field: +100 per match, +20 consecutive, +30 prefix, +15 word-boundary,
// -1 per gap capped at -40, -Infinity if any needle char is not found.
// Entry score = max(title*1.0, subtitle*0.5, keywords*0.3).
// Tie-break: (1) shorter title length, (2) alphabetical title, (3) type priority
// page > project > assignment > playbook > server > todo.

const GAP_PENALTY = -1;
const GAP_CAP = -40;

export function scoreField(needle: string, haystack: string): number {
  if (needle.length === 0) return 0;
  if (haystack.length === 0) return -Infinity;

  let score = 0;
  let hi = 0;
  let lastMatchIdx = -2;
  let gapRun = 0;

  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = false;
    while (hi < haystack.length) {
      if (haystack[hi] === ch) {
        score += 100;
        if (hi === lastMatchIdx + 1) score += 20;
        if (hi === 0) score += 30;
        else {
          const prev = haystack[hi - 1];
          if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') score += 15;
        }
        if (gapRun > 0) score += Math.max(GAP_CAP, gapRun * GAP_PENALTY);
        lastMatchIdx = hi;
        gapRun = 0;
        hi++;
        found = true;
        break;
      } else {
        gapRun++;
        hi++;
      }
    }
    if (!found) return -Infinity;
  }
  return score;
}

const TYPE_PRIORITY: Record<string, number> = {
  page: 0,
  project: 1,
  assignment: 2,
  playbook: 3,
  server: 4,
  todo: 5,
};

export interface RankableEntry {
  type: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
}

export function rankAll<T extends RankableEntry>(
  query: string,
  entries: T[],
  limit = 50,
): Array<T & { score: number }> {
  const q = query.toLowerCase();
  if (!q) return entries.slice(0, limit).map((e) => ({ ...e, score: 0 }));

  const scored = entries.map((e) => {
    const titleScore = scoreField(q, e.title.toLowerCase()) * 1.0;
    const subtitleScore = e.subtitle
      ? scoreField(q, e.subtitle.toLowerCase()) * 0.5
      : -Infinity;
    const keywordScore = e.keywords?.length
      ? scoreField(q, e.keywords.join(' ').toLowerCase()) * 0.3
      : -Infinity;
    const score = Math.max(titleScore, subtitleScore, keywordScore);
    return { ...e, score };
  });
  const filtered = scored.filter((e) => e.score > -Infinity);
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.title.length !== b.title.length) return a.title.length - b.title.length;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99);
  });
  return filtered.slice(0, limit);
}
