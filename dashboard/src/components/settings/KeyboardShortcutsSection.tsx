import { SectionCard } from '../SectionCard';

const SHORTCUTS = [
  { keys: 'g n', description: 'Go to Needs me' },
  { keys: 'g b', description: 'Go to Board' },
  { keys: 'g s', description: 'Go to Sessions' },
  { keys: 'g l', description: 'Go to Library' },
  { keys: 'g ,', description: 'Go to Settings' },
  { keys: 'n', description: 'Create new ticket' },
] as const;

export function KeyboardShortcutsSection() {
  return (
    <SectionCard
      title="Keyboard shortcuts"
      description="Navigation and ticket creation shortcuts. Typing in inputs, editors, and open dialogs is never intercepted."
    >
      <ul className="divide-y divide-border/50 rounded-md border border-border/60">
        {SHORTCUTS.map((row) => (
          <li key={row.keys} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{row.description}</span>
            <kbd className="rounded border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground">
              {row.keys}
            </kbd>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
