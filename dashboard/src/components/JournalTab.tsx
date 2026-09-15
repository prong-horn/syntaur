import { useCallback, useEffect, useMemo, useState } from 'react';
import { chatAttachmentUrl } from '../lib/chat-attachments';
import { formatRelativeTime } from '../lib/format';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import type { TicketLogEntryDetail, TicketTemplateFileDetail } from '../hooks/useProjects';
import { cn } from '../lib/utils';

const ALL_TYPES = [
  'progress',
  'decision',
  'handoff',
  'note',
  'question',
  'answer',
  'review',
] as const;

interface LogResponse {
  path: string;
  entries: TicketLogEntryDetail[];
}

export interface JournalTabProps {
  ticketId: string;
  file: TicketTemplateFileDetail;
  onAppended?: () => void;
}

function parseVerdictBadge(verdictKey: string | undefined): string | null {
  if (!verdictKey) return null;
  const match = verdictKey.match(/^(approve|changes)\b/);
  return match?.[1] ?? null;
}

function attachmentIdFromStoredName(name: string): string | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return name.slice(0, idx);
}

function openQuestionEntries(entries: TicketLogEntryDetail[]): TicketLogEntryDetail[] {
  const answered = new Set(
    entries
      .filter((e) => e.type === 'answer' && e.keys?.answers)
      .map((e) => e.keys!.answers),
  );
  return entries.filter((e) => e.type === 'question' && !answered.has(e.timestamp));
}

export function JournalTab({ ticketId, file, onAppended }: JournalTabProps) {
  const allowedTypes = file.entryTypes ?? [...ALL_TYPES];
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [entries, setEntries] = useState<TicketLogEntryDetail[]>(file.logEntries ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryType, setEntryType] = useState(allowedTypes[0] ?? 'progress');
  const [body, setBody] = useState('');
  const [verdict, setVerdict] = useState<'approve' | 'changes'>('approve');
  const [openHigh, setOpenHigh] = useState('0');
  const [openMedium, setOpenMedium] = useState('0');
  const [answers, setAnswers] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = typeFilter ? `?type=${encodeURIComponent(typeFilter)}` : '';
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/log${params}`);
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to load journal');
      }
      const data = (await res.json()) as LogResponse;
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journal');
    } finally {
      setLoading(false);
    }
  }, [ticketId, typeFilter]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const allEntries = useMemo(() => {
    if (typeFilter) return entries;
    return file.logEntries && !loading ? file.logEntries : entries;
  }, [entries, file.logEntries, loading, typeFilter]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of ALL_TYPES) counts.set(t, 0);
    for (const entry of allEntries) {
      counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    }
    return counts;
  }, [allEntries]);

  const openQuestions = useMemo(() => openQuestionEntries(allEntries), [allEntries]);

  const displayEntries = typeFilter
    ? entries
    : allEntries;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;

    const payload: Record<string, string> = { type: entryType, body: trimmed };
    if (entryType === 'review') {
      payload.verdict = verdict;
      payload.open = `high=${openHigh},medium=${openMedium}`;
    }
    if (entryType === 'answer') {
      if (!answers) {
        setError('Select a question to answer');
        return;
      }
      payload.answers = answers;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to append entry');
      }
      setBody('');
      setAnswers('');
      await loadEntries();
      onAppended?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to append entry');
    } finally {
      setSubmitting(false);
    }
  }

  if (!file.exists) {
    return (
      <EmptyState
        title={`Not created yet (createOn: ${file.createOn})`}
        description=""
      />
    );
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Journal" description={`${file.state} · ${file.description}`}>
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs font-medium',
              typeFilter === null ? 'border-primary bg-primary/10' : 'border-border/60',
            )}
            onClick={() => setTypeFilter(null)}
          >
            All ({allEntries.length})
          </button>
          {ALL_TYPES.filter((t) => allowedTypes.includes(t)).map((t) => {
            const count = typeCounts.get(t) ?? 0;
            if (count === 0 && typeFilter !== t) return null;
            return (
              <button
                key={t}
                type="button"
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize',
                  typeFilter === t ? 'border-primary bg-primary/10' : 'border-border/60',
                )}
                onClick={() => setTypeFilter(typeFilter === t ? null : t)}
              >
                {t} ({count})
              </button>
            );
          })}
        </div>

        {loading ? <p className="text-sm text-muted-foreground">Loading entries…</p> : null}
        {error ? (
          <p className="rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
            {error}
          </p>
        ) : null}

        {displayEntries.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">No journal entries yet.</p>
        ) : (
          <ol className="space-y-4">
            {displayEntries.map((entry, idx) => {
              const verdictBadge = entry.type === 'review' ? parseVerdictBadge(entry.keys?.verdict) : null;
              const attachmentNames = entry.keys?.attachments
                ?.split(',')
                .map((s) => s.trim())
                .filter(Boolean) ?? [];
              return (
                <li key={`${entry.timestamp}-${idx}`} className="border-l-2 border-border pl-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-muted-foreground">
                    <span>{formatRelativeTime(entry.timestamp)}</span>
                    <span>·</span>
                    <span className="capitalize">{entry.type}</span>
                    {entry.author ? (
                      <>
                        <span>·</span>
                        <span>{entry.author}</span>
                      </>
                    ) : null}
                    {verdictBadge ? (
                      <span className="rounded-full border border-border/60 px-2 py-0.5 font-sans capitalize">
                        {verdictBadge}
                      </span>
                    ) : null}
                    {entry.type === 'answer' && entry.keys?.answers ? (
                      <span className="font-sans">
                        answers{' '}
                        <button
                          type="button"
                          className="text-primary underline"
                          onClick={() => setTypeFilter('question')}
                        >
                          {entry.keys.answers}
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {attachmentNames.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {attachmentNames.map((name) => {
                        const attachmentId = attachmentIdFromStoredName(name);
                        if (!attachmentId) return null;
                        return (
                          <a
                            key={name}
                            href={chatAttachmentUrl(ticketId, attachmentId)}
                            target="_blank"
                            rel="noreferrer"
                            className="block overflow-hidden rounded border border-border/60"
                          >
                            <img
                              src={chatAttachmentUrl(ticketId, attachmentId)}
                              alt={name}
                              className="h-16 w-16 object-cover"
                            />
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                  <MarkdownRenderer content={entry.body} />
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>

      <SectionCard title="Append entry" description="Append-only journal entries via syntaur log semantics.">
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Type
              <select
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
                className="rounded-md border border-border/70 bg-background px-2 py-1"
              >
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {entryType === 'review' ? (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  Verdict
                  <select
                    value={verdict}
                    onChange={(e) => setVerdict(e.target.value as 'approve' | 'changes')}
                    className="rounded-md border border-border/70 bg-background px-2 py-1"
                  >
                    <option value="approve">approve</option>
                    <option value="changes">changes</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Open high
                  <input
                    type="number"
                    min={0}
                    value={openHigh}
                    onChange={(e) => setOpenHigh(e.target.value)}
                    className="w-20 rounded-md border border-border/70 bg-background px-2 py-1"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Open medium
                  <input
                    type="number"
                    min={0}
                    value={openMedium}
                    onChange={(e) => setOpenMedium(e.target.value)}
                    className="w-20 rounded-md border border-border/70 bg-background px-2 py-1"
                  />
                </label>
              </>
            ) : null}
            {entryType === 'answer' ? (
              <label className="flex min-w-[16rem] flex-col gap-1 text-sm">
                Question
                <select
                  value={answers}
                  onChange={(e) => setAnswers(e.target.value)}
                  required
                  className="rounded-md border border-border/70 bg-background px-2 py-1"
                >
                  <option value="">Select open question…</option>
                  {openQuestions.map((q) => (
                    <option key={q.timestamp} value={q.timestamp}>
                      {q.firstLine || q.timestamp}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            required
            placeholder="Entry body…"
            className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm leading-6"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || !body.trim() || (entryType === 'answer' && !answers)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {submitting ? 'Appending…' : 'Append'}
            </button>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
