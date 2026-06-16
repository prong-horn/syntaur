import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { compileQuery, type QueryItem } from '@shared/query';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { rankAll } from './fuzzy';
import type { PaletteEntry } from './paletteIndex';
import { splitPaletteQuery, PALETTE_FIELDS } from './paletteQuery';
import { suggestPalette, type Suggestion, type SuggestContext } from './paletteSuggest';
import { useHotkeyContext } from './HotkeyProvider';
import { useSearchConfig } from '../hooks/useSearchConfig';
import { useStatusConfig } from '../hooks/useStatusConfig';
import { useTypesConfig } from '../hooks/useTypesConfig';

interface CommandPaletteProps {
  entries: PaletteEntry[];
}

const TYPE_LABEL: Record<string, string> = {
  page: 'Page',
  project: 'Project',
  assignment: 'Assignment',
  playbook: 'Playbook',
  server: 'Server',
  todo: 'Todo',
};

export function CommandPalette({ entries }: CommandPaletteProps) {
  const { paletteOpen, closePalette } = useHotkeyContext();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(true);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { search: searchCfg } = useSearchConfig();
  const statusCfg = useStatusConfig();
  const typesCfg = useTypesConfig();

  // Split the raw query into an AQL filter gate + free-text terms, applying the
  // config-driven aliases and default scope. The gate compiles against the FULL
  // PALETTE_FIELDS registry — external-ID suppression is handled by buildIndex
  // (empty haystacks), not by filtering the registry here.
  const { aqlExpr, fuzzy } = useMemo(
    () => splitPaletteQuery(query, searchCfg.aliases, { defaultScope: searchCfg.defaultScope }),
    [query, searchCfg.aliases, searchCfg.defaultScope],
  );

  // Suggestion context: field names (minus jira/externalid when external IDs are
  // off) + value sources (status/type from config; tag/assignee/externalid derived
  // from the loaded entries).
  const suggestCtx = useMemo<SuggestContext>(() => {
    const tags = new Set<string>();
    const assignees = new Set<string>();
    const externalIds = new Set<string>();
    for (const e of entries) {
      for (const tag of e.tags ?? []) tags.add(tag);
      if (e.assignee) assignees.add(e.assignee);
      for (const x of e.externalIds ?? []) {
        if (!x.id) continue;
        externalIds.add(x.id);
        if (x.system) externalIds.add(`${x.system}:${x.id}`);
      }
    }
    const allFields = Object.keys(PALETTE_FIELDS);
    return {
      aliases: searchCfg.aliases,
      fields: searchCfg.externalIds
        ? allFields
        : allFields.filter((f) => f !== 'jira' && f !== 'externalid'),
      values: {
        status: statusCfg.statuses.map((s) => s.id),
        type: typesCfg.definitions.map((d) => d.id),
        tag: [...tags],
        assignee: [...assignees],
        externalid: searchCfg.externalIds ? [...externalIds] : [],
      },
    };
  }, [entries, searchCfg.aliases, searchCfg.externalIds, statusCfg.statuses, typesCfg.definitions]);

  const suggestions = useMemo(
    () => suggestPalette(query, caret, suggestCtx),
    [query, caret, suggestCtx],
  );
  // Intentional: on an empty box we show the static "Prefixes" legend (below)
  // rather than the dropdown, so the two don't overlap/duplicate. The dropdown
  // takes over from the first keystroke. Discoverability on first open is covered
  // by the legend, which lists the same prefixes.
  const showSuggestions = suggestOpen && suggestions.length > 0 && query.trim() !== '';

  const ranked = useMemo(() => {
    let survivors = entries;
    let rankText = fuzzy;
    if (aqlExpr) {
      const result = compileQuery(aqlExpr, PALETTE_FIELDS);
      if (result.query) {
        // EvalContext.now is required (resolves relative duration literals).
        const now = Date.now();
        const { predicate } = result.query;
        survivors = entries.filter((e) => predicate(e as unknown as QueryItem, { now }));
      } else {
        // Bad gate: ignore it and rank the original query over everything (fuzzy
        // is '' in explicit-AQL mode, which would otherwise show all entries).
        rankText = query;
      }
    }
    return rankAll(rankText, survivors, 50);
  }, [entries, aqlExpr, fuzzy, query]);

  useEffect(() => {
    setSelected(0);
  }, [query, paletteOpen]);

  // Keep the suggestion highlight in range as the suggestion set changes.
  useEffect(() => {
    setSuggestIdx(0);
  }, [suggestions]);

  // Reset transient state when closed so next open is clean.
  useEffect(() => {
    if (!paletteOpen) {
      setQuery('');
      setCaret(0);
      setSuggestOpen(true);
    }
  }, [paletteOpen]);

  // Scroll selected into view on selection change.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-idx="${selected}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function handleOpen(entry: PaletteEntry) {
    navigate(entry.route);
    closePalette();
  }

  function acceptSuggestion(s: Suggestion) {
    const next = query.slice(0, s.replace[0]) + s.insert + query.slice(s.replace[1]);
    const nextCaret = s.replace[0] + s.insert.length;
    setQuery(next);
    setCaret(nextCaret);
    // Leave the dropdown open so a chained suggestion (e.g. `status:` → values)
    // appears immediately; it self-closes when nothing is left to suggest.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (showSuggestions) {
      // Accept on Tab, or → only when the caret is at the end of the input.
      if (e.key === 'Tab' || (e.key === 'ArrowRight' && caret >= query.length)) {
        e.preventDefault();
        const s = suggestions[suggestIdx];
        if (s) acceptSuggestion(s);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestIdx((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        // Enter always opens the selected result — never accepts a suggestion.
        e.preventDefault();
        const entry = ranked[selected];
        if (entry) handleOpen(entry);
        return;
      }
      // Esc is handled by the Dialog's onEscapeKeyDown (closes the dropdown first);
      // any other key falls through to normal typing.
      return;
    }

    // Dropdown closed: navigate the results list (today's behavior).
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(ranked.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = ranked[selected];
      if (entry) handleOpen(entry);
    }
  }

  return (
    <Dialog open={paletteOpen} onOpenChange={(o) => (o ? null : closePalette())}>
      <DialogContent
        className="max-w-xl p-0 gap-0"
        onEscapeKeyDown={(e) => {
          // Esc closes the suggestions dropdown first, then (next press) the palette.
          if (showSuggestions) {
            e.preventDefault();
            setSuggestOpen(false);
          }
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="relative">
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setSuggestOpen(true);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            placeholder="Search…  try  a:  p:  jira:PROJ-123  tag:backend"
            className="w-full rounded-t-xl border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0"
          />
          {showSuggestions ? (
            <div className="absolute left-0 right-0 top-full z-50 max-h-64 overflow-y-auto border-b border-border/70 bg-background shadow-lg">
              {suggestions.map((s, i) => {
                const highlighted = i === suggestIdx;
                return (
                  <button
                    key={`${s.kind}-${s.insert}-${i}`}
                    type="button"
                    // onMouseDown (not onClick) so the input keeps focus on accept.
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      acceptSuggestion(s);
                    }}
                    onMouseEnter={() => setSuggestIdx(i)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-sm ${
                      highlighted ? 'bg-accent text-accent-foreground' : 'text-foreground'
                    }`}
                  >
                    <code className="truncate">{s.label}</code>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.kind}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {aqlExpr ? (
          <div className="border-b border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium">Filtering</span> <code className="text-foreground">{aqlExpr}</code>
            {fuzzy ? <span> · ranking “{fuzzy}”</span> : null}
          </div>
        ) : query.trim() === '' ? (
          <div className="border-b border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium">Prefixes</span>{' '}
            {Object.keys(searchCfg.aliases).map((p) => (
              <code key={p} className="mr-1">
                {p}:
              </code>
            ))}
            {' · '}
            <code>status:</code> <code>tag:</code> <code>assignee:</code> <code>type:</code>{' '}
            {searchCfg.externalIds ? <code>jira:</code> : null}
          </div>
        ) : null}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1">
          {ranked.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No matches
            </div>
          ) : (
            ranked.map((entry, idx) => {
              const isSelected = idx === selected;
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-palette-idx={idx}
                  onClick={() => handleOpen(entry)}
                  onMouseEnter={() => setSelected(idx)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50 text-foreground'
                  }`}
                >
                  <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {TYPE_LABEL[entry.type] ?? entry.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  {entry.subtitle ? (
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      {entry.subtitle}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          <span>
            {showSuggestions
              ? `\u21E5/\u2192 accept \u00B7 \u2191\u2193 suggestions \u00B7 Esc close`
              : `\u2191\u2193 navigate \u00B7 \u21B5 open \u00B7 Esc close`}
          </span>
          <span>{ranked.length} result{ranked.length === 1 ? '' : 's'}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
