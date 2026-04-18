import { useMemo } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { useHotkeyContext, type HotkeyScope } from './HotkeyProvider';
import { formatPatternForDisplay } from './match';

const SCOPE_LABEL: Record<HotkeyScope, string> = {
  global: 'Global',
  'list:missions': 'Missions list',
  'list:assignments': 'Assignments list',
  'list:todos': 'Todos list',
  assignment: 'Assignment detail',
  mission: 'Mission detail',
};

const SCOPE_ORDER: HotkeyScope[] = [
  'global',
  'list:missions',
  'list:assignments',
  'list:todos',
  'mission',
  'assignment',
];

function formatKeys(keys: string): string {
  // "g o" => "g then O"; "Mod+k" => "⌘K"; "?" => "?"
  if (keys.includes(' ')) {
    const [first, second] = keys.split(' ');
    return `${formatPatternForDisplay(first)} then ${formatPatternForDisplay(second)}`;
  }
  return formatPatternForDisplay(keys);
}

export function CheatsheetDialog() {
  const { cheatsheetOpen, closeCheatsheet, listBindings } = useHotkeyContext();

  const grouped = useMemo(() => {
    if (!cheatsheetOpen) return new Map<HotkeyScope, Array<{ keys: string; description: string }>>();
    const bindings = listBindings();
    const map = new Map<HotkeyScope, Array<{ keys: string; description: string }>>();
    for (const b of bindings) {
      const list = map.get(b.scope) ?? [];
      list.push({ keys: b.keys, description: b.description });
      map.set(b.scope, list);
    }
    return map;
  }, [cheatsheetOpen, listBindings]);

  return (
    <Dialog open={cheatsheetOpen} onOpenChange={(o) => (o ? null : closeCheatsheet())}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Press Esc to close. {formatPatternForDisplay('Mod+k')} opens the command palette. Press g twice to restart the chord timer.
        </DialogDescription>
        <div className="mt-2 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {SCOPE_ORDER.map((scope) => {
            const items = grouped.get(scope);
            if (!items || items.length === 0) return null;
            return (
              <section key={scope}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {SCOPE_LABEL[scope]}
                </h3>
                <ul className="space-y-1">
                  {items.map((b, idx) => (
                    <li
                      key={`${scope}-${b.keys}-${idx}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-1.5 text-sm"
                    >
                      <span className="text-foreground">{b.description}</span>
                      <kbd className="shrink-0 rounded border border-border/70 bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                        {formatKeys(b.keys)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
