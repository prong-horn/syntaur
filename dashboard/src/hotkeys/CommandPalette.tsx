import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { rankAll } from './fuzzy';
import type { PaletteEntry } from './paletteIndex';
import { useHotkeyContext } from './HotkeyProvider';

interface CommandPaletteProps {
  entries: PaletteEntry[];
}

const TYPE_LABEL: Record<string, string> = {
  page: 'Page',
  mission: 'Mission',
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
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => rankAll(query, entries, 50), [query, entries]);

  useEffect(() => {
    setSelected(0);
  }, [query, paletteOpen]);

  // Reset query when closed so next open is clean.
  useEffect(() => {
    if (!paletteOpen) setQuery('');
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

  function handleKeyDown(e: React.KeyboardEvent) {
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
      <DialogContent className="max-w-xl p-0 gap-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search missions, assignments, playbooks, servers, todos…"
          className="w-full rounded-t-xl border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0"
        />
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1">
          {ranked.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {query ? 'No matches' : 'Start typing to search'}
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
          <span>{'\u2191\u2193'} navigate {'\u00B7'} {'\u21B5'} open {'\u00B7'} Esc close</span>
          <span>{ranked.length} result{ranked.length === 1 ? '' : 's'}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
