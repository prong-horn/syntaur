import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { rankAll } from './fuzzy';
import type { Action } from './actionsIndex';
import { useHotkeyContext } from './HotkeyProvider';

interface ActionPaletteProps {
  entries: Action[];
}

interface RankableAction {
  type: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  action: Action;
}

export function ActionPalette({ entries }: ActionPaletteProps) {
  const { actionsPaletteOpen, closeActionsPalette } = useHotkeyContext();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [promptAction, setPromptAction] = useState<Action | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [running, setRunning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const rankable: RankableAction[] = useMemo(
    () =>
      entries.map((a) => ({
        type: a.group.toLowerCase(),
        title: a.title,
        subtitle: a.subtitle,
        keywords: a.keywords,
        action: a,
      })),
    [entries],
  );

  const ranked = useMemo(() => rankAll(query, rankable, 50), [query, rankable]);

  useEffect(() => {
    setSelected(0);
  }, [query, actionsPaletteOpen]);

  // Reset everything when closed.
  useEffect(() => {
    if (!actionsPaletteOpen) {
      setQuery('');
      setPromptAction(null);
      setPromptValue('');
      setRunning(false);
    }
  }, [actionsPaletteOpen]);

  // Scroll selected into view on selection change.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-idx="${selected}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  async function executeAction(action: Action) {
    if (action.requiresInput) {
      setPromptAction(action);
      setPromptValue('');
      return;
    }
    if (!action.run) return;
    setRunning(true);
    try {
      await action.run();
    } finally {
      setRunning(false);
      closeActionsPalette();
    }
  }

  async function submitPrompt() {
    if (!promptAction?.requiresInput) return;
    const value = promptValue.trim();
    if (!value) return;
    setRunning(true);
    try {
      await promptAction.requiresInput.runWithInput(value);
    } finally {
      setRunning(false);
      closeActionsPalette();
    }
  }

  function handlePickerKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(ranked.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = ranked[selected];
      if (entry) executeAction(entry.action);
    }
  }

  function handlePromptKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPrompt();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPromptAction(null);
      setPromptValue('');
    }
  }

  const inPromptMode = promptAction !== null;

  return (
    <Dialog
      open={actionsPaletteOpen}
      onOpenChange={(o) => (o ? null : closeActionsPalette())}
    >
      <DialogContent className="max-w-xl p-0 gap-0">
        <DialogTitle className="sr-only">Actions palette</DialogTitle>
        {inPromptMode ? (
          <>
            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
              <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {promptAction!.group}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {promptAction!.title}
              </span>
            </div>
            <input
              autoFocus
              type="text"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptAction!.requiresInput!.placeholder}
              disabled={running}
              className="w-full border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0 disabled:opacity-60"
            />
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{'↵'} submit {'·'} Esc back</span>
              <span>{running ? 'Running…' : ''}</span>
            </div>
          </>
        ) : (
          <>
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handlePickerKeyDown}
              placeholder="Run an action: new project, new todo, toggle…"
              className="w-full rounded-t-xl border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0"
            />
            <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1">
              {ranked.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {query ? 'No matches' : 'Start typing to search actions'}
                </div>
              ) : (
                ranked.map((entry, idx) => {
                  const isSelected = idx === selected;
                  return (
                    <button
                      key={entry.action.id}
                      type="button"
                      data-palette-idx={idx}
                      onClick={() => executeAction(entry.action)}
                      onMouseEnter={() => setSelected(idx)}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent/50 text-foreground'
                      }`}
                    >
                      <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {entry.action.group}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.action.title}</span>
                      {entry.action.subtitle ? (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {entry.action.subtitle}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{'↑↓'} navigate {'·'} {'↵'} run {'·'} Esc close</span>
              <span>{ranked.length} action{ranked.length === 1 ? '' : 's'}</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
