import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { useContentSearch, type ContentMatchRange } from '../../hooks/useContentSearch';
import { useProjects, useTicketsBoard, usePlaybooks } from '../../hooks/useProjects';
import { ticketPageHref } from '../../lib/routes';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SearchRow {
  id: string;
  label: string;
  detail?: string;
  href: string;
  type: string;
}

function normalizeRanges(matches: ContentMatchRange[], len: number): Array<{ start: number; end: number }> {
  const clamped = matches
    .map((m) => ({
      start: Math.max(0, Math.min(m.start, len)),
      end: Math.max(0, Math.min(m.end, len)),
    }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const m of clamped) {
    const last = merged[merged.length - 1];
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else merged.push({ ...m });
  }
  return merged;
}

function highlightSnippet(snippet: string, matches?: ContentMatchRange[]): ReactNode {
  if (!matches?.length) return snippet;
  const ranges = normalizeRanges(matches, snippet.length);
  if (!ranges.length) return snippet;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((m, i) => {
    if (m.start > cursor) out.push(<Fragment key={`t${i}`}>{snippet.slice(cursor, m.start)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className="rounded bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30">
        {snippet.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  if (cursor < snippet.length) out.push(<Fragment key="tail">{snippet.slice(cursor)}</Fragment>);
  return out;
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const { data: projects } = useProjects(open);
  const { data: ticketsBoard } = useTicketsBoard(open);
  const { data: playbooksData } = usePlaybooks(open);
  const { hits: contentHits, loading: contentLoading } = useContentSearch(query, open);

  const trimmed = query.trim().toLowerCase();

  const entityRows = useMemo<SearchRow[]>(() => {
    if (!open || trimmed.length < 1) return [];
    const rows: SearchRow[] = [];
    for (const p of projects ?? []) {
      const hay = `${p.slug} ${p.title}`.toLowerCase();
      if (hay.includes(trimmed)) {
        rows.push({
          id: `project:${p.slug}`,
          label: p.title,
          detail: p.slug,
          href: `/board?project=${encodeURIComponent(p.slug)}`,
          type: 'Project',
        });
      }
    }
    for (const t of ticketsBoard?.tickets ?? []) {
      const hay = `${t.id} ${t.title} ${t.projectSlug ?? ''}`.toLowerCase();
      if (hay.includes(trimmed)) {
        rows.push({
          id: `ticket:${t.id}`,
          label: t.title,
          detail: t.id,
          href: ticketPageHref(t.id),
          type: 'Ticket',
        });
      }
    }
    for (const pb of playbooksData?.playbooks ?? []) {
      const hay = `${pb.slug} ${pb.name}`.toLowerCase();
      if (hay.includes(trimmed)) {
        rows.push({
          id: `playbook:${pb.slug}`,
          label: pb.name,
          detail: pb.slug,
          href: `/library/playbooks/${encodeURIComponent(pb.slug)}`,
          type: 'Playbook',
        });
      }
    }
    return rows.slice(0, 12);
  }, [open, trimmed, projects, ticketsBoard, playbooksData]);

  const contentRows = useMemo<SearchRow[]>(() => {
    return contentHits.slice(0, 12).map((hit) => ({
      id: `content:${hit.ticketId}:${hit.path}:${hit.line}`,
      label: hit.snippet.trim() || hit.path,
      detail: hit.ticketId ? `${hit.ticketId} · ${hit.path}` : hit.path,
      href: hit.route || (hit.ticketId ? ticketPageHref(hit.ticketId) : '/board'),
      type: 'Content',
      snippet: hit.snippet,
      matches: hit.matches,
    }));
  }, [contentHits]);

  type ContentRow = SearchRow & { snippet?: string; matches?: ContentMatchRange[] };
  const rows: ContentRow[] = [...entityRows, ...contentRows];

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function go(row: SearchRow) {
    onOpenChange(false);
    navigate(row.href);
  }

  function onInputKeydown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, rows.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === 'Enter' && rows[selected]) {
      event.preventDefault();
      go(rows[selected]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
    }
  }

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeydown}
            placeholder="Search tickets, projects, playbooks, and file content…"
            className="flex-1 bg-transparent text-sm outline-none"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `${listboxId}-${selected}` : undefined}
          />
        </div>
        <div ref={listRef} id={listboxId} role="listbox" className="max-h-80 overflow-y-auto p-1">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {contentLoading ? 'Searching…' : trimmed ? 'No matches' : 'Type to search'}
            </p>
          ) : (
            rows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                id={`${listboxId}-${index}`}
                data-index={index}
                aria-selected={index === selected}
                className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left text-sm ${
                  index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                }`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => go(row)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{row.label}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{row.type}</span>
                </span>
                {row.snippet ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {highlightSnippet(row.snippet, row.matches)}
                  </span>
                ) : row.detail ? (
                  <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
